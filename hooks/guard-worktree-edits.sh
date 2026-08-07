#!/usr/bin/env bash
# PreToolUse guard: keep file edits inside the active worktree / repo root.
#
# Fires before Edit / Write / MultiEdit / NotebookEdit. If the target file
# resolves OUTSIDE the git top-level of the session cwd — the classic
# "I'm in a worktree but editing the parent repo" bleed — it returns an
# `ask` permission decision so CC prompts you to confirm instead of silently
# applying (and instead of auto mode waving it through).
#
# Always allowed (pass straight through, no prompt):
#   - inside the active tree's root, EXCEPT its own .claude/worktrees/ (those
#     are OTHER trees; the main repo is treated as just another tree)
#   - temp / scratch dirs ($TMPDIR, /tmp, the harness scratchpad)
#   - ~/.claude  (your global CC config)
#   - the project's own <main-repo>/.claude/  EXCEPT .claude/worktrees/ — the
#     worktree session loads skills/agents/settings from the main repo's .claude/
#     (via the filesystem walk), so editing them is intentional; but editing some
#     OTHER worktree under .claude/worktrees/ still asks.
#
# Why a hook and not another CLAUDE.md warning line: prose can't reliably stop
# an LLM from resolving a path to the parent repo, and the auto-mode classifier
# only checks the trust boundary, not "worktree vs main repo". This is the
# deterministic boundary that actually holds.
#
# Anchor choice: allowed root = `git -C "$cwd" rev-parse --show-toplevel`.
# Inside a worktree that returns the worktree dir itself, so the nested
# `<main-repo>/.claude/worktrees/<branch>/` layout works in our favour — the
# parent-repo files sit ABOVE this root and fall outside the prefix.
#
# Contract notes (non-obvious):
#   - stdout MUST be either empty (allow) or a single JSON object (the ask
#     decision). All diagnostics go to $LOG, never stdout, or CC can't parse it.
#   - We run WITHOUT `set -e` and always exit 0: if anything here breaks we want
#     to fail OPEN (allow the edit), never wedge the user's editing.
#   - Standalone (no worktree-lib source). A single jq pass extracts every field
#     so the hot path spawns jq once; in-worktree edits (the common case) pay
#     only one `git rev-parse`, and the `git worktree list` fallback runs only
#     for worktrees outside the <repo>/.claude/worktrees/ convention.
#   - DEBUG (below): at 1, every invocation logs its params + verdict EXCEPT
#     in-root — that is the bulk of real traffic and would drown the log. At 0,
#     only `ask` decisions are logged.

set -uo pipefail

LOG="$HOME/.claude/worktree-guard.log"
DEBUG=1   # 1 = log every call (params + verdict); 0 = log only `ask` decisions.

STDIN_JSON="$(cat)"

# Single exit point. $1 = ALLOW|ASK, $2 = short reason tag, $3 = ask reason text.
# Logs one record per call when DEBUG=1 — minus in-root, which is the bulk of
# real traffic and carries no signal — and always for ASK; then emits the ask
# JSON on stdout only for ASK. Vars may be unset at early exits → ${x:-?}.
verdict() {
  if [[ "$1" == ASK || ( "$DEBUG" == 1 && "$2" != in-root ) ]]; then
    {
      printf '%s %s(%s) tool=%s\n' "$(date -Iseconds)" "$1" "$2" "${TOOL:-?}"
      printf '  cwd=%s\n  target=%s\n  root=%s\n' "${CWD:-?}" "${ABS:-?}" "${ROOT:-?}"
      [[ "$DEBUG" == 1 ]] && printf '  raw=%s\n' "${STDIN_JSON:0:500}"
    } >> "$LOG"
  fi
  [[ "$1" == ASK ]] && jq -n --arg r "${3:-}" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# One jq pass for all three fields (Edit/Write/MultiEdit carry file_path,
# NotebookEdit carries notebook_path). @tsv keeps them on one line for `read`.
TOOL="" CWD="" FILE=""
IFS=$'\t' read -r TOOL CWD FILE < <(
  printf '%s' "$STDIN_JSON" | jq -r '
    [ (.tool_name // ""),
      (.cwd // ""),
      (.tool_input.file_path // .tool_input.notebook_path // "") ] | @tsv' 2>/dev/null
) || true
[[ -n "$CWD" ]] || CWD="$PWD"

ABS=""; ROOT=""

# No path to check → allow.
[[ -n "$FILE" ]] || verdict ALLOW no-file

# Canonicalize a path without requiring the whole thing to exist (Write may
# target a not-yet-created file). Resolves symlinks + `..` on the existing
# leading portion and re-appends the missing tail. Relative paths resolve
# against the session cwd.
canon() {
  local p="$1" dir base
  [[ "$p" = /* ]] || p="$CWD/$p"
  if [[ -d "$p" ]]; then ( cd "$p" 2>/dev/null && pwd -P ); return; fi
  dir="$(dirname "$p")"; base="$(basename "$p")"
  while [[ ! -d "$dir" && "$dir" != "/" && "$dir" != "." ]]; do
    base="$(basename "$dir")/$base"; dir="$(dirname "$dir")"
  done
  if [[ -d "$dir" ]]; then printf '%s/%s\n' "$(cd "$dir" && pwd -P)" "$base"
  else printf '%s\n' "$p"; fi
}
# Canonicalize an existing directory (allowlist root); echo as-is if missing.
canondir() { cd "$1" 2>/dev/null && pwd -P || printf '%s' "$1"; }

ABS="$(canon "$FILE")"

# Allowed root = git top-level of the session cwd. Not a git repo → don't
# interfere at all.
ROOT="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT" ]] || verdict ALLOW not-git
ROOT="$(canondir "$ROOT")"

# Always-allow prefixes: temp/scratch dirs and the user's global ~/.claude.
for t in "${TMPDIR:-}" /tmp /private/tmp /var/folders "$HOME/.claude"; do
  [[ -n "$t" ]] || continue
  tc="$(canondir "$t")"
  [[ -n "$tc" ]] || continue
  [[ "$ABS/" == "$tc/"* ]] && verdict ALLOW "allow:$t"
done

# Inside the active tree → allow. (Common case exits here, before the HOST
# lookup below.) Exception: this root's own .claude/worktrees/ holds OTHER
# trees. The model is "the main repo is just another worktree" — a session may
# only touch files under its own root, so crossing into a sibling tree asks in
# BOTH directions, main repo → worktree included.
[[ "$ABS/" == "$ROOT/"* && "$ABS/" != "$ROOT/.claude/worktrees/"* ]] && verdict ALLOW in-root

# Outside the worktree. Allow the project's OWN .claude/ in the main repo, but
# keep .claude/worktrees/ (other worktrees) gated.
#
# HOST = the directory this worktree lives under, i.e. everything left of
# `/.claude/worktrees/` in ROOT. That is the ancestor CC walks up to when it
# loads project skills/agents — exactly what this whitelist exists for.
#
# Derive it from the PATH, not from git. `git worktree list` answers a different
# question ("where does git think the main working tree is"): it takes the common
# gitdir's realpath minus a trailing `/.git`, so a repo created with
# --separate-git-dir (its `.git` is a FILE pointing at a gitdir named something
# else) reports the gitdir itself and this whitelist can never match. And from
# inside a linked worktree git holds no pointer back to the main working tree at
# all, so no git command can supply it — the information only lives in the path.
HOST=""
case "$ROOT" in
  */.claude/worktrees/*) HOST="${ROOT%%/.claude/worktrees/*}" ;;
esac
# Fallback for worktrees outside our own <repo>/.claude/worktrees/ convention:
# first entry of `git worktree list` (the primary worktree). substr, not $2, so
# paths with spaces (e.g. an iCloud/Obsidian vault) survive.
[[ -n "$HOST" ]] || HOST="$(git -C "$CWD" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')"
if [[ -n "$HOST" ]]; then
  MC="$(canondir "$HOST")"
  if [[ "$ABS/" == "$MC/.claude/"* && "$ABS/" != "$MC/.claude/worktrees/"* ]]; then
    verdict ALLOW main-claude
  fi
fi

# Outside everything allowed → ask. Give the model a reason it can act on.
REASON="Edit target is OUTSIDE the active tree.
  target:      $ABS
  active tree: $ROOT
Every tree — the main repo counts as one — may only edit files under its own
root. This target belongs to a different tree: the parent repo, or a sibling
worktree under .claude/worktrees/. If you meant this tree's own copy, re-target
the path under the root above. Confirm only if crossing trees is intended."

verdict ASK outside-worktree "$REASON"
