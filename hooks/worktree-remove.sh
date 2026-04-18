#!/usr/bin/env bash
# WorktreeRemove hook: cleans up worktrees created by worktree-create.sh.
#   - Removes the worktree (without --force; keeps dirty worktrees intact)
#   - Deletes the associated branch
#   - Removes empty parent dirs under .claude/worktrees/ (e.g. feat/, hotfix/)

set -euo pipefail

LOG="$HOME/.claude/worktree-hook.log"
STDIN_JSON="$(cat)"

{
  echo "=== $(date -Iseconds) WorktreeRemove ==="
  echo "$STDIN_JSON"
} >> "$LOG"

jq_first() {
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

PATH_RAW="$(jq_first '.worktree_path' '.path' '.worktreePath' '.hookSpecificOutput.worktreePath')"
NAME="$(jq_first '.name' '.worktreeName')"
CWD="$(jq_first '.cwd')"

if [[ -n "$CWD" ]]; then
  cd "$CWD"
fi

# WorktreeRemove cannot block (docs: failures logged only). Always exit 0.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "worktree-remove hook: not inside a git repository (cwd=$PWD)" >&2
  exit 0
fi

# CC invokes this hook from inside the worktree being removed, so we cannot
# run `git worktree remove` or `git branch -D` from here directly. Resolve the
# main repo root (first entry in `git worktree list --porcelain`) and run all
# destructive git ops there via `git -C`.
MAIN_REPO="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
if [[ -z "$MAIN_REPO" ]] || [[ ! -d "$MAIN_REPO" ]]; then
  echo "worktree-remove hook: could not determine main repo root" >&2
  exit 0
fi
WORKTREES_ROOT="$MAIN_REPO/.claude/worktrees"

# Resolve worktree path.
WT_PATH=""
if [[ -n "$PATH_RAW" ]]; then
  WT_PATH="$PATH_RAW"
elif [[ -n "$NAME" ]]; then
  # 1) Try default layout .claude/worktrees/<name>
  if [[ -d "$WORKTREES_ROOT/$NAME" ]]; then
    WT_PATH="$WORKTREES_ROOT/$NAME"
  else
    # 2) Search registered worktrees for a path ending in a date-stamped variant of name.
    #    e.g. name=feat/hook-smoke-test -> path .../feat/260418-hook-smoke-test
    REST="${NAME#feat/}"
    REST="${REST#hotfix/}"
    WT_PATH="$(git worktree list --porcelain \
      | awk '/^worktree /{print $2}' \
      | grep -E "/(feat|hotfix)/[0-9]{6}-${REST}$" \
      | head -1 || true)"
  fi
fi

if [[ -z "$WT_PATH" ]] || [[ ! -d "$WT_PATH" ]]; then
  echo "worktree-remove hook: couldn't resolve worktree path (path=$PATH_RAW name=$NAME); skipping" >&2
  exit 0
fi

# Get branch before removing (symbolic-ref fails on detached HEAD; that's fine).
BRANCH="$(git -C "$WT_PATH" symbolic-ref --short HEAD 2>/dev/null || true)"

# Remove worktree without --force: a dirty worktree will fail and be preserved.
# Must run from main repo since our cwd may be the worktree itself.
if ! git -C "$MAIN_REPO" worktree remove "$WT_PATH" >&2 2>&1; then
  echo "worktree-remove hook: git worktree remove failed (likely dirty); leaving intact" >&2
  exit 0
fi

# Branch cleanup (only if the worktree really went away). Same cwd caveat.
if [[ -n "$BRANCH" ]]; then
  git -C "$MAIN_REPO" branch -D "$BRANCH" >&2 2>&1 || echo "worktree-remove hook: could not delete branch $BRANCH" >&2
fi

# Parent cleanup: rmdir only removes empty directories, and we gate on the
# parent being a strict descendant of WORKTREES_ROOT so we never touch anything
# outside `.claude/worktrees/`.
PARENT="$(dirname "$WT_PATH")"
if [[ "$PARENT" != "$WORKTREES_ROOT" ]] && [[ "$PARENT" == "$WORKTREES_ROOT"/* ]]; then
  rmdir "$PARENT" 2>/dev/null || true
fi

exit 0
