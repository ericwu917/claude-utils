#!/usr/bin/env bash
# claude-utils installer — idempotent merge into ~/.claude/settings.json.
#
# Usage:
#   ./install.sh [--all | --hooks | --statusline] [--dry-run] [--quiet] [-y]
#
# Points ~/.claude/settings.json at the scripts in this repo (not copies).
# `git pull` then upgrades in place — no re-install needed unless settings
# schema changes.

set -euo pipefail

INSTALL_HOOKS=1
INSTALL_STATUSLINE=1
COMPONENT_FLAG_SET=0
DRY_RUN=0
QUIET=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Components (default: all):
  --all            Install both hooks and statusline (default)
  --hooks          Install only the worktree lifecycle hooks
  --statusline    Install only the custom statusline

Options:
  --dry-run       Print the diff that would be applied; don't write
  -q, --quiet     Minimize output
  -h, --help      Show this help

Environment:
  CLAUDE_CONFIG_DIR  Override the Claude Code config dir (default: ~/.claude)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)        INSTALL_HOOKS=1; INSTALL_STATUSLINE=1; COMPONENT_FLAG_SET=1 ;;
    --hooks)      INSTALL_HOOKS=1; INSTALL_STATUSLINE=0; COMPONENT_FLAG_SET=1 ;;
    --statusline) INSTALL_HOOKS=0; INSTALL_STATUSLINE=1; COMPONENT_FLAG_SET=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -q|--quiet)   QUIET=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
: "$COMPONENT_FLAG_SET"  # silence shellcheck about unused var; kept for future

REPO_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
MERGE_DOC="$REPO_ROOT/docs/SETTINGS_MERGE.md"

log()  { [[ $QUIET -eq 1 ]] || echo "$@"; }
warn() { echo "$@" >&2; }

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

hook_foreign_commands() {
  local event="$1" script_basename="$2"
  jq -r --arg e "$event" --arg s "$script_basename" '
    .hooks[$e] // [] | map(.hooks // []) | flatten
    | map(select((.command // "") | test("/" + $s + "$") | not))
    | map(.command // "") | .[]
  ' "$TMP"
}

upsert_hook() {
  local event="$1" script_path="$2" timeout="$3"
  local script_basename="${script_path##*/}"
  local foreign
  foreign="$(hook_foreign_commands "$event" "$script_basename" || true)"
  if [[ -n "$foreign" ]]; then
    warn "Conflict: $event already has non-claude-utils hooks:"
    printf '%s\n' "$foreign" | sed 's/^/    /' >&2
    warn "  Skipping $event. See $MERGE_DOC for manual merge."
    return 1
  fi
  jq --arg e "$event" \
     --arg cmd "$script_path" \
     --argjson timeout "$timeout" \
     --arg s "$script_basename" '
    .hooks //= {}
    | .hooks[$e] = (
        ((.hooks[$e] // [])
          | map(select((.hooks // []) | all((.command // "") | test("/" + $s + "$") | not))))
        + [ { hooks: [ { type: "command", command: $cmd, timeout: $timeout } ] } ]
      )
  ' "$TMP" > "$TMP.new"
  mv "$TMP.new" "$TMP"
}

if [[ $INSTALL_HOOKS -eq 1 ]]; then
  if upsert_hook WorktreeCreate "$REPO_ROOT/hooks/worktree-create.sh" 120 \
     && upsert_hook WorktreeRemove "$REPO_ROOT/hooks/worktree-remove.sh" 60; then
    log "✓ hooks: WorktreeCreate, WorktreeRemove → $REPO_ROOT/hooks/"
  fi
fi

# ── Statusline ────────────────────────────────────────────────────────────
# Identified by script path substring `/statusline/statusline.sh`.

if [[ $INSTALL_STATUSLINE -eq 1 ]]; then
  statusline_cmd="bash $REPO_ROOT/statusline/statusline.sh"
  existing_statusline="$(jq -r '.statusline.command // empty' "$TMP")"
  if [[ -n "$existing_statusline" && "$existing_statusline" != *"/statusline/statusline.sh"* ]]; then
    warn "Conflict: statusline.command already set to:"
    warn "    $existing_statusline"
    warn "  Skipping statusline. See $MERGE_DOC for manual merge."
  else
    jq --arg cmd "$statusline_cmd" '
      .statusline //= {}
      | .statusline.command = $cmd
    ' "$TMP" > "$TMP.new"
    mv "$TMP.new" "$TMP"
    log "✓ statusline → $REPO_ROOT/statusline/statusline.sh"
  fi
fi

# ── Commit ────────────────────────────────────────────────────────────────

if cmp -s "$SETTINGS" "$TMP"; then
  log "No changes to $SETTINGS"
  exit 0
fi

if [[ $DRY_RUN -eq 1 ]]; then
  log "Dry run — diff that would be applied:"
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
