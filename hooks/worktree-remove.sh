#!/usr/bin/env bash
# WorktreeRemove hook: cleans up worktrees created by worktree-create.sh.
#   - Removes the worktree (without --force; dirty/untracked preserved).
#   - Deletes the associated branch IF the worktree is gone AND the
#     branch's tip is preserved elsewhere (merged into develop / master
#     / main, or reachable from any remote ref). Otherwise the branch
#     is kept so `git branch -D` can't drop unpushed unmerged work; the
#     create hook's reuse logic will reattach a worktree next time.
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
# shellcheck source=worktree-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/worktree-lib.sh"
STDIN_JSON="$(cat)"

{
  echo "=== $(date -Iseconds) WorktreeRemove ==="
  echo "$STDIN_JSON"
} >> "$LOG"

# Write one line to both stderr (CC surfaces it to the user) and the log file.
say() {
  echo "worktree-remove hook: $*" >&2
  log "$*"
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

# Resolve worktree path. resolve_worktree_from_name is the shared helper that
# worktree-create.sh's reuse logic is built on, so name→path stays symmetric
# across the two hooks (and we avoid building regexes from untrusted name
# segments).
WT_PATH=""
if [[ -n "$PATH_RAW" ]]; then
  WT_PATH="$PATH_RAW"
elif [[ -n "$NAME" ]]; then
  WT_PATH="$(resolve_worktree_from_name "$MAIN_REPO" "$WORKTREES_ROOT" "$NAME")"
fi

if [[ -z "$WT_PATH" ]] || [[ ! -d "$WT_PATH" ]]; then
  say "couldn't resolve worktree path (path=$PATH_RAW name=$NAME); skipping"
  log "git worktree list at failure:"
  git -C "$MAIN_REPO" worktree list --porcelain >> "$LOG" 2>&1 || true
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
# Gated on branch_is_safely_preserved: `git branch -D` is force-delete,
# so dropping a branch whose tip isn't on any remote and isn't in
# develop/master/main would lose unrecoverable user work.
if [[ -n "$BRANCH" ]]; then
  if branch_is_safely_preserved "$MAIN_REPO" "$BRANCH"; then
    set +e
    BRANCH_ERR="$(git -C "$MAIN_REPO" branch -D "$BRANCH" 2>&1 1>/dev/null)"
    BRANCH_RC=$?
    set -e
    if [[ "$BRANCH_RC" -ne 0 ]]; then
      say "could not delete branch $BRANCH: $BRANCH_ERR"
    else
      say "deleted branch $BRANCH"
    fi
  else
    say "kept branch $BRANCH (not merged into develop/master/main and not on any remote)"
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
