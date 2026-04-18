#!/usr/bin/env bash
# WorktreeCreate hook: creates a git worktree with a date-stamped branch.
#
#   Input (stdin JSON): Claude Code's WorktreeCreate payload. The worktree
#   name field location isn't fully documented, so we probe multiple paths.
#
#   Naming convention:
#     feat/<rest>    -> branch feat/<YYMMDD>-<rest>   based on origin/develop
#     hotfix/<rest>  -> branch hotfix/<YYMMDD>-<rest> based on origin/master
#     <other>        -> branch worktree-<name>        based on origin/HEAD
#
#   Output (stdout): absolute path of the created worktree.
#   Non-zero exit aborts creation.

set -euo pipefail

LOG="$HOME/.claude/worktree-hook.log"
STDIN_JSON="$(cat)"

{
  echo "=== $(date -Iseconds) ==="
  echo "$STDIN_JSON"
} >> "$LOG"

jq_first() {
  # Return first non-empty value among the jq paths given.
  local path val
  for path in "$@"; do
    val="$(printf '%s' "$STDIN_JSON" | jq -r "$path // empty" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "null" ]]; then
      printf '%s' "$val"
      return 0
    fi
  done
  return 0
}

NAME="$(jq_first '.name' '.tool_input.name' '.toolInput.name' '.worktreeName' '.hookSpecificOutput.name')"
CWD="$(jq_first '.cwd')"

if [[ -z "$NAME" ]]; then
  echo "worktree-create hook: could not extract name from stdin. See $LOG" >&2
  exit 1
fi

if [[ -n "$CWD" ]]; then
  cd "$CWD"
fi

# Must be inside a git repo for the git-based flow.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "worktree-create hook: not inside a git repository (cwd=$PWD)" >&2
  exit 1
fi

TODAY="$(date +%y%m%d)"

case "$NAME" in
  feat/*)
    REST="${NAME#feat/}"
    BRANCH="feat/${TODAY}-${REST}"
    BASE="origin/develop"
    ;;
  hotfix/*)
    REST="${NAME#hotfix/}"
    BRANCH="hotfix/${TODAY}-${REST}"
    BASE="origin/master"
    ;;
  *)
    BRANCH="worktree-${NAME}"
    BASE="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    if [[ -z "$BASE" ]]; then
      BASE="HEAD"
    fi
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
WT_PATH="$REPO_ROOT/.claude/worktrees/$BRANCH"

# Fetch so origin/develop / origin/master / origin/HEAD are current.
git fetch origin --quiet >&2 || echo "worktree-create hook: git fetch failed, continuing with local refs" >&2

# Verify base exists; if not (e.g. origin/develop missing in some repo), fall back to origin/HEAD.
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "worktree-create hook: base $BASE not found, falling back to origin/HEAD" >&2
  BASE="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo HEAD)"
fi

mkdir -p "$(dirname "$WT_PATH")"
git worktree add -b "$BRANCH" "$WT_PATH" "$BASE" >&2

# stdout = the absolute worktree path Claude Code should chdir into.
echo "$WT_PATH"
