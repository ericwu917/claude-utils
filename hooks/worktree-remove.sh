#!/usr/bin/env bash
# WorktreeRemove hook: cleans up worktrees created by worktree-create.sh.
#   - Removes the worktree (without --force; dirty/untracked preserved).
#   - Deletes the associated branch if the worktree is gone.
#   - Removes empty parent dirs under .claude/worktrees/ (e.g. feat/, hotfix/).
#
# Exit semantics:
#   0  — worktree successfully removed (or branch cleanup was the only partial
#        failure, which is a secondary issue)
#   1  — any resolution or removal failure. Claude Code shows the stderr
#        message to the user. The worktree is never force-deleted, so exit 1
#        is safe — it just surfaces "I refused to delete this" instead of
#        silently pretending success.
#
# Every status line is mirrored to $LOG so you can audit after the fact.

set -euo pipefail

LOG="$HOME/.claude/worktree-hook.log"
STDIN_JSON="$(cat)"

log() { printf '%s\n' "$*" >> "$LOG"; }

{
  echo "=== $(date -Iseconds) WorktreeRemove ==="
  echo "$STDIN_JSON"
} >> "$LOG"

# Write one line to both stderr (CC surfaces it to the user) and the log file.
say() {
  echo "worktree-remove hook: $*" >&2
  log "$*"
}

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

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  say "not inside a git repository (cwd=$PWD); skipping"
  exit 1
fi

# CC invokes this hook from inside the worktree being removed, so we cannot
# run `git worktree remove` or `git branch -D` from here directly. Resolve the
# main repo root (first entry in `git worktree list --porcelain`) and run all
# destructive git ops there via `git -C`.
MAIN_REPO="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
if [[ -z "$MAIN_REPO" ]] || [[ ! -d "$MAIN_REPO" ]]; then
  say "could not determine main repo root"
  exit 1
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
  say "couldn't resolve worktree path (path=$PATH_RAW name=$NAME); skipping"
  exit 1
fi

# Get branch before removing (symbolic-ref fails on detached HEAD; that's fine).
BRANCH="$(git -C "$WT_PATH" symbolic-ref --short HEAD 2>/dev/null || true)"

# Remove worktree without --force: dirty/untracked stays put on purpose.
# Capture git's stderr so we can echo the real reason to the user + log.
set +e
REMOVE_ERR="$(git -C "$MAIN_REPO" worktree remove "$WT_PATH" 2>&1 1>/dev/null)"
REMOVE_RC=$?
set -e
if [[ "$REMOVE_RC" -ne 0 ]]; then
  say "git worktree remove failed for $WT_PATH:"
  say "  $REMOVE_ERR"
  say "  (worktree preserved; run 'git -C $MAIN_REPO worktree remove --force $WT_PATH' to force-delete)"
  exit 1
fi
say "removed worktree $WT_PATH"

# Branch cleanup (only if the worktree really went away). Same cwd caveat.
if [[ -n "$BRANCH" ]]; then
  set +e
  BRANCH_ERR="$(git -C "$MAIN_REPO" branch -D "$BRANCH" 2>&1 1>/dev/null)"
  BRANCH_RC=$?
  set -e
  if [[ "$BRANCH_RC" -ne 0 ]]; then
    say "could not delete branch $BRANCH: $BRANCH_ERR"
  else
    say "deleted branch $BRANCH"
  fi
fi

# Parent cleanup: rmdir only removes empty directories, and we gate on the
# parent being a strict descendant of WORKTREES_ROOT so we never touch anything
# outside `.claude/worktrees/`.
PARENT="$(dirname "$WT_PATH")"
if [[ "$PARENT" != "$WORKTREES_ROOT" ]] && [[ "$PARENT" == "$WORKTREES_ROOT"/* ]]; then
  rmdir "$PARENT" 2>/dev/null && log "removed empty parent dir $PARENT" || true
fi

exit 0
