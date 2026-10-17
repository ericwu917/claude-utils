#!/usr/bin/env bash
# claude-utils installer — copies the runtime files into ~/.claude and merges
# their entries into ~/.claude/settings.json, idempotently.
#
# Usage:
#   ./install.sh [--all | --hooks | --mods | --statusline] [--dry-run] [--quiet]
#
# Copies, never links: the runtime under ~/.claude stays independent of this
# working tree (a checkout on another branch can't break a live session). To
# upgrade, `git pull` and rerun install.sh.
#
#   hooks       ~/.claude/hooks/{worktree-create,worktree-remove,worktree-lib,guard-worktree-edits,guard-rm}.sh
#   mods        ~/.claude/mods/statusband/  + ~/.claude/statusline-refresh-caches.sh
#               + ~/Library/LaunchAgents/com.taige.claude-refresh-caches.plist
#   statusline  ~/.claude/statusline-command.sh (+ refresh script and its
#               LaunchAgent, hooks/last-reply.sh)
#               — retired in favor of the statusband mod; kept as a fallback

set -euo pipefail

INSTALL_HOOKS=1
INSTALL_MODS=1
INSTALL_STATUSLINE=0
DRY_RUN=0
QUIET=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Components (default: --all):
  --all            Install the hooks and the mods (default)
  --hooks          Install only the worktree hooks
  --mods           Install only the statusband mod (status band above the prompt)
  --statusline     Install only the legacy statusline.sh (fallback; replaced
                   by the statusband mod)

Options:
  --dry-run       Show what would be copied and the settings diff; don't write
  -q, --quiet     Minimize output
  -h, --help      Show this help

Environment:
  CLAUDE_CONFIG_DIR  Override the Claude Code config dir (default: ~/.claude)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)        INSTALL_HOOKS=1; INSTALL_MODS=1; INSTALL_STATUSLINE=0 ;;
    --hooks)      INSTALL_HOOKS=1; INSTALL_MODS=0; INSTALL_STATUSLINE=0 ;;
    --mods)       INSTALL_HOOKS=0; INSTALL_MODS=1; INSTALL_STATUSLINE=0 ;;
    --statusline) INSTALL_HOOKS=0; INSTALL_MODS=0; INSTALL_STATUSLINE=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -q|--quiet)   QUIET=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
MERGE_DOC="$REPO_ROOT/docs/SETTINGS_MERGE.md"

log()  { [[ $QUIET -eq 1 ]] || echo "$@"; }
warn() { echo "$@" >&2; }

# How settings.json names a runtime file: under the default config dir as
# $HOME/.claude/..., so the entry survives a renamed home; elsewhere absolute.
rt_path() {
  if [[ "$CLAUDE_DIR" == "$HOME/.claude" ]]; then
    printf '%s' "\$HOME/.claude/$1"
  else
    printf '%s' "$CLAUDE_DIR/$1"
  fi
}

# The same, spelled with ~ for values a shell doesn't expand $HOME in
# (CLAUDE_CODE_PLUGIN_DIRS takes ~; statusLine.command is fine either way).
rt_tilde_path() {
  if [[ "$CLAUDE_DIR" == "$HOME/.claude" ]]; then
    # shellcheck disable=SC2088  # a literal ~ is the point: it goes into JSON
    printf '%s' "~/.claude/$1"
  else
    printf '%s' "$CLAUDE_DIR/$1"
  fi
}

# Copy a repo file (or directory) to the runtime, reporting what changed.
# Under --dry-run it only reports.
install_copy() {
  local src="$REPO_ROOT/$1" dst="$CLAUDE_DIR/$2" state
  if [[ -d "$src" ]]; then
    # Ignore the engine's typings under .claude-plugin/types; compare the rest.
    # (Collected first: under pipefail, diff's own exit 1 would mask grep's.)
    local changes=""
    [[ -d "$dst" ]] && changes="$(diff -rq "$src" "$dst" 2>&1 | grep -vE '\.claude-plugin(/|: )types' || true)"
    if [[ -d "$dst" && -z "$changes" ]]; then state=unchanged
    elif [[ -e "$dst" ]]; then state=updated; else state=new; fi
  else
    if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then state=unchanged
    elif [[ -e "$dst" ]]; then state=updated; else state=new; fi
  fi
  if [[ $DRY_RUN -eq 0 && $state != unchanged ]]; then
    mkdir -p "$(dirname "$dst")"
    if [[ -d "$src" ]]; then
      rm -rf "$dst" && cp -R "$src" "$dst"
      # Engine-written typings: generated per build, never shipped.
      rm -rf "$dst/.claude-plugin/types"
    else
      cp "$src" "$dst" && chmod +x "$dst"
    fi
  fi
  log "  $state: $2"
}

# The ccusage cost cache is refreshed by launchd every 30 minutes, not by the
# status line or the mod (they only read it): ccusage re-reads every JSONL,
# minutes on a large history. Written from a template, so it is compared and
# reported like a copied file; (re)loaded when it changed or isn't loaded.
LAUNCH_LABEL=com.taige.claude-refresh-caches
install_launch_agent() {
  local dst="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist" domain tmp state
  domain="gui/$(id -u)"
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LAUNCH_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$CLAUDE_DIR/statusline-refresh-caches.sh</string>
        <string>ccusage</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StartInterval</key>
    <integer>1800</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF
  if [[ -f "$dst" ]] && cmp -s "$tmp" "$dst"; then state=unchanged
  elif [[ -e "$dst" ]]; then state=updated; else state=new; fi
  if [[ $DRY_RUN -eq 0 ]]; then
    if [[ $state != unchanged ]]; then
      mkdir -p "$(dirname "$dst")"
      cp "$tmp" "$dst"
      launchctl bootout "$domain/$LAUNCH_LABEL" 2>/dev/null || true
    fi
    if ! launchctl print "$domain/$LAUNCH_LABEL" >/dev/null 2>&1; then
      launchctl bootstrap "$domain" "$dst" \
        || warn "  launchctl bootstrap failed; load it with: launchctl bootstrap $domain $dst"
    fi
  fi
  rm -f "$tmp"
  log "  $state: $dst"
}

if ! command -v jq >/dev/null 2>&1; then
  warn "claude-utils install: jq is required."
  warn "  Install jq, or follow the manual instructions at:"
  warn "    $MERGE_DOC"
  exit 2
fi

mkdir -p "$CLAUDE_DIR"

if [[ ! -f "$SETTINGS" ]]; then
  echo "{}" > "$SETTINGS"
  log "Created $SETTINGS"
fi

if ! jq empty "$SETTINGS" >/dev/null 2>&1; then
  warn "$SETTINGS is not valid JSON. Fix or remove it, then rerun."
  exit 2
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP" "$TMP.new"' EXIT
cp "$SETTINGS" "$TMP"

# ── Hooks ─────────────────────────────────────────────────────────────────
# Entries are identified for upgrade by script basename (worktree-create.sh,
# worktree-remove.sh). Unrelated hooks in the same event slot are preserved
# and surfaced as a conflict (we do not edit them).

# Every hook script this repo installs; several share PreToolUse, so none of
# them counts as foreign to the others.
OUR_HOOKS='(worktree-create|worktree-remove|guard-worktree-edits|guard-rm|last-reply)\.sh"?$'

hook_foreign_commands() {
  local event="$1"
  jq -r --arg e "$event" --arg ours "/$OUR_HOOKS" '
    .hooks[$e] // [] | map(.hooks // []) | flatten
    | map(select((.command // "") | test($ours) | not))
    | map(.command // "") | .[]
  ' "$TMP"
}

upsert_hook() {
  local event="$1" script_path="$2" timeout="$3" matcher="${4:-}"
  local script_basename="${script_path##*/}"
  local foreign
  foreign="$(hook_foreign_commands "$event" || true)"
  if [[ -n "$foreign" ]]; then
    warn "Conflict: $event already has non-claude-utils hooks:"
    printf '%s\n' "$foreign" | sed 's/^/    /' >&2
    warn "  Skipping $event. See $MERGE_DOC for manual merge."
    return 1
  fi
  # matcher (4th arg, optional) scopes tool-level events like PreToolUse to
  # specific tools; the worktree-lifecycle events pass none and get a bare entry.
  jq --arg e "$event" \
     --arg cmd "$script_path" \
     --argjson timeout "$timeout" \
     --arg s "$script_basename" \
     --arg matcher "$matcher" '
    .hooks //= {}
    | .hooks[$e] = (
        ((.hooks[$e] // [])
          | map(select((.hooks // []) | all((.command // "") | test("/" + $s + "$") | not))))
        + [ (if $matcher == "" then {} else { matcher: $matcher } end)
            + { hooks: [ { type: "command", command: $cmd, timeout: $timeout } ] } ]
      )
  ' "$TMP" > "$TMP.new"
  mv "$TMP.new" "$TMP"
}

# Hook commands are quoted so a path with spaces survives the shell.
hook_cmd() { printf '"%s"' "$(rt_path "hooks/$1")"; }

if [[ $INSTALL_HOOKS -eq 1 ]]; then
  log "hooks → $CLAUDE_DIR/hooks/"
  for f in worktree-create.sh worktree-remove.sh worktree-lib.sh guard-worktree-edits.sh guard-rm.sh; do
    install_copy "hooks/$f" "hooks/$f"
  done
  hooks_ok=1
  upsert_hook WorktreeCreate "$(hook_cmd worktree-create.sh)" 120 || hooks_ok=0
  upsert_hook WorktreeRemove "$(hook_cmd worktree-remove.sh)" 60  || hooks_ok=0
  # PreToolUse guard: ask before edits whose target is outside the active
  # worktree root (the "in a worktree, editing the parent repo" bleed). Scoped
  # to the file-editing tools via matcher.
  upsert_hook PreToolUse "$(hook_cmd guard-worktree-edits.sh)" 10 "Edit|Write|MultiEdit|NotebookEdit" || hooks_ok=0
  # PreToolUse guard: ask before recursive rm, except inside the session
  # scratchpad.
  upsert_hook PreToolUse "$(hook_cmd guard-rm.sh)" 10 "Bash" || hooks_ok=0
  if [[ $hooks_ok -eq 1 ]]; then
    log "✓ hooks: WorktreeCreate, WorktreeRemove, PreToolUse"
  fi
  # An ask rule beats any hook "allow", so these would keep prompting even in
  # the scratchpad. Removing them is left to the user; just point them out.
  stale="$(jq -r '.permissions.ask // [] | map(select(test("^Bash\\(rm -rf?[: ]"))) | .[]' "$TMP")"
  if [[ -n "$stale" ]]; then
    warn "Note: guard-rm.sh replaces these permissions.ask rules; remove them from $SETTINGS"
    warn "  or recursive rm in the scratchpad will still prompt:"
    printf '%s\n' "$stale" | sed 's/^/    /' >&2
  fi
fi

# ── Mods ──────────────────────────────────────────────────────────────────
# Loaded through env.CLAUDE_CODE_PLUGIN_DIRS (CLI and desktop sessions alike);
# other folders already listed there are kept, ours is appended once.

if [[ $INSTALL_MODS -eq 1 ]]; then
  log "mods → $CLAUDE_DIR/mods/"
  install_copy mods/statusband mods/statusband
  # statusband reads the ccusage cost cache this script refreshes from launchd.
  install_copy statusline/statusline-refresh-caches.sh statusline-refresh-caches.sh
  install_launch_agent
  jq --arg dir "$(rt_tilde_path mods/statusband)" '
    .env //= {}
    | .env.CLAUDE_CODE_PLUGIN_DIRS = (
        (.env.CLAUDE_CODE_PLUGIN_DIRS // "" | split(":") | map(select(. != "" and (endswith("/mods/statusband") | not))))
        + [$dir] | join(":"))
  ' "$TMP" > "$TMP.new"
  mv "$TMP.new" "$TMP"
  log "✓ mods: statusband (env.CLAUDE_CODE_PLUGIN_DIRS)"
fi

# ── Statusline (legacy fallback) ──────────────────────────────────────────
# Replaced by the statusband mod; kept for setups without mods. Identified for
# upgrade by the runtime name `statusline-command.sh` (or a repo path).

if [[ $INSTALL_STATUSLINE -eq 1 ]]; then
  log "statusline (legacy) → $CLAUDE_DIR/"
  install_copy statusline/statusline.sh statusline-command.sh
  install_copy statusline/statusline-refresh-caches.sh statusline-refresh-caches.sh
  install_launch_agent
  install_copy hooks/last-reply.sh hooks/last-reply.sh
  statusline_cmd="bash $(rt_tilde_path statusline-command.sh)"
  existing_statusline="$(jq -r '.statusLine.command // empty' "$TMP")"
  if [[ -n "$existing_statusline" && "$existing_statusline" != *"statusline-command.sh"* \
        && "$existing_statusline" != *"/statusline/statusline.sh"* ]]; then
    warn "Conflict: statusLine.command already set to:"
    warn "    $existing_statusline"
    warn "  Skipping statusline. See $MERGE_DOC for manual merge."
  else
    jq --arg cmd "$statusline_cmd" '.statusLine = { type: "command", command: $cmd }' "$TMP" > "$TMP.new"
    mv "$TMP.new" "$TMP"
    # Stop fires when CC finishes a reply; last-reply.sh timestamps the session
    # for the statusline's ⏱ segment. Short timeout — trivial write.
    log "✓ statusline: statusLine"
    if upsert_hook Stop "$(hook_cmd last-reply.sh)" 5; then
      log "✓ statusline: Stop hook (last-reply.sh)"
    fi
  fi
fi

# ── Commit ────────────────────────────────────────────────────────────────

if cmp -s "$SETTINGS" "$TMP"; then
  log "No changes to $SETTINGS"
  exit 0
fi

if [[ $DRY_RUN -eq 1 ]]; then
  log "Dry run — nothing copied; settings diff that would be applied:"
  diff -u "$SETTINGS" "$TMP" || true
  exit 0
fi

BACKUP="$SETTINGS.bak.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$BACKUP"
mv "$TMP" "$SETTINGS"
trap - EXIT

log ""
log "Settings updated. Backup: $BACKUP"
log "Restart Claude Code or run /hooks to reload hooks."
