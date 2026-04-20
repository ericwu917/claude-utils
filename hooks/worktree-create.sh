#!/usr/bin/env bash
# WorktreeCreate hook: creates or reuses a git worktree with a date-stamped branch.
#
#   Input (stdin JSON): Claude Code's WorktreeCreate payload. The worktree
#   name field location isn't fully documented, so we probe multiple paths.
#
#   Naming convention (on first creation):
#     input name     branch                            path under .claude/worktrees/
#     feat/<rest>    feat/<YYMMDD>-<rest>   (develop)  feat/<YYMMDD>-<rest>/
#     hotfix/<rest>  hotfix/<YYMMDD>-<rest> (master)   hotfix/<YYMMDD>-<rest>/
#     <other>        worktree-<name>        (HEAD)     <name>/    (matches CC default)
#
#   Input normalization: a leading `worktree-` prefix on the plain case is
#   stripped so `claude -w worktree-foo` (a branch name pasted from
#   `git branch`) resolves to the same worktree as `claude -w foo`.
#
#   Reuse semantics (#3):
#     - A matching feat/*-<rest> (or hotfix/*-<rest>) branch from any day is
#       reused in preference to stamping today's date on a new branch.
#     - If the branch exists but no worktree holds it, we attach a new
#       worktree at the standard path.
#     - If the standard-path worktree already exists on the target branch,
#       we just echo that path.
#     - If the branch is checked out at some other path under
#       $REPO_ROOT/.claude/worktrees/ (e.g. CC's own default layout from
#       before this hook was installed, or a legacy prefixed path from an
#       earlier hook version), we fall back to that path.
#     - Error (do not mutate) when: the branch is checked out truly outside
#       our worktrees root; or the standard path exists but holds a
#       different branch or isn't a tracked worktree.
#
#   Output (stdout): absolute path of the worktree to chdir into.
#   Non-zero exit aborts creation.

set -euo pipefail

LOG="$HOME/.claude/worktree-hook.log"
STDIN_JSON="$(cat)"

log() { printf '%s\n' "$*" >> "$LOG"; }

{
  echo "=== $(date -Iseconds) ==="
  echo "$STDIN_JSON"
} >> "$LOG"

die() {
  echo "worktree-create hook: $*" >&2
  log "ERROR: $*"
  exit 1
}

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

[[ -n "$NAME" ]] || die "could not extract name from stdin. See $LOG"

if [[ -n "$CWD" ]]; then
  cd "$CWD"
fi

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository (cwd=$PWD)"

REPO_ROOT="$(git rev-parse --show-toplevel)"

# ---- Helpers ----

# Print the worktree path holding BRANCH (empty if none).
find_worktree_for_branch() {
  local br="$1"
  git -C "$REPO_ROOT" worktree list --porcelain | awk -v target="refs/heads/$br" '
    /^worktree / { path = substr($0, 10) }
    $1 == "branch" && $2 == target { print path; exit }
  '
}

# Print the branch at worktree $1, empty if path isn't registered or is detached.
branch_at_worktree_path() {
  local path="$1"
  git -C "$REPO_ROOT" worktree list --porcelain | awk -v target="$path" '
    /^worktree / { cur = substr($0, 10) }
    $1 == "branch" && cur == target { sub(/^refs\/heads\//, "", $2); print $2; exit }
  '
}

# Exit 0 if $1 is a registered worktree path.
is_registered_worktree() {
  local path="$1"
  git -C "$REPO_ROOT" worktree list --porcelain | awk -v target="$path" '
    /^worktree / { if (substr($0, 10) == target) { found = 1; exit } }
    END { exit !found }
  '
}

# Print newest branch matching <prefix>/<6-digit>-<rest>, empty if none.
# The 6-digit guard prevents a human-created branch like feat/cleanup-foo from
# being silently reused for input `feat/foo`, and keeps the path in sync with
# worktree-remove.sh's cleanup regex.
find_existing_dated_branch() {
  local prefix="$1" rest="$2" ref suffix
  while IFS= read -r ref; do
    suffix="${ref#"$prefix/"}"
    if [[ "$suffix" =~ ^[0-9]{6}- ]] && [[ "${suffix#??????-}" == "$rest" ]]; then
      printf '%s\n' "$ref"
      return 0
    fi
  done < <(git -C "$REPO_ROOT" for-each-ref \
              --sort=-committerdate \
              --format='%(refname:short)' \
              "refs/heads/$prefix/*" 2>/dev/null)
}

branch_exists() {
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$1"
}

# ---- Resolve target BRANCH ----

TODAY="$(date +%y%m%d)"

case "$NAME" in
  feat/*)
    REST="${NAME#feat/}"
    EXISTING="$(find_existing_dated_branch feat "$REST")"
    if [[ -n "$EXISTING" ]]; then
      BRANCH="$EXISTING"
      log "reusing existing branch $BRANCH for input $NAME"
    else
      BRANCH="feat/${TODAY}-${REST}"
    fi
    BASE="origin/develop"
    ;;
  hotfix/*)
    REST="${NAME#hotfix/}"
    EXISTING="$(find_existing_dated_branch hotfix "$REST")"
    if [[ -n "$EXISTING" ]]; then
      BRANCH="$EXISTING"
      log "reusing existing branch $BRANCH for input $NAME"
    else
      BRANCH="hotfix/${TODAY}-${REST}"
    fi
    BASE="origin/master"
    ;;
  *)
    # If the user pasted a branch name that already has our `worktree-`
    # prefix (easy to do — `git branch` lists them that way), strip it so
    # we don't stack prefixes into `worktree-worktree-<x>`. Require at
    # least one char after the prefix so bare `worktree-` still fails loudly.
    if [[ "$NAME" == worktree-?* ]]; then
      log "normalizing input $NAME -> ${NAME#worktree-} (prefix already present)"
      NAME="${NAME#worktree-}"
    fi
    BRANCH="worktree-${NAME}"
    # Align plain-name path with Claude Code's own -w default layout
    # (.claude/worktrees/<name>/). The worktree- prefix is kept on the
    # branch name only, so hook-created branches still stand out in
    # `git branch`, but the on-disk directory stays clean.
    WT_NAME="$NAME"
    BASE="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    [[ -n "$BASE" ]] || BASE="HEAD"
    ;;
esac

WT_PATH="$REPO_ROOT/.claude/worktrees/${WT_NAME:-$BRANCH}"

# Clean up any stale registration whose directory was manually rm -rf'd.
# Idempotent; only affects entries git already considers broken.
git -C "$REPO_ROOT" worktree prune >&2 2>/dev/null || true

# ---- State dispatch ----

# (a) Standard path already occupied.
if [[ -d "$WT_PATH" ]]; then
  is_registered_worktree "$WT_PATH" || \
    die "$WT_PATH exists but isn't a tracked git worktree; please remove it manually"
  BRANCH_AT_PATH="$(branch_at_worktree_path "$WT_PATH")"
  if [[ "$BRANCH_AT_PATH" != "$BRANCH" ]]; then
    die "$WT_PATH is a worktree for ${BRANCH_AT_PATH:-detached HEAD}, not $BRANCH"
  fi
  log "reusing existing worktree at $WT_PATH"
  echo "$WT_PATH"
  exit 0
fi

# (b) Branch already checked out somewhere in this repo.
# Accept any existing worktree under $REPO_ROOT/.claude/worktrees/ — this covers
# Claude Code's own default layout (.claude/worktrees/<name>/, used when no hook
# is installed), earlier hook path conventions, and manual mkdir variants.
# Dropping the user into the real location is strictly better than refusing to
# enter. We still error if the branch is checked out somewhere genuinely foreign
# (e.g. the main repo checkout itself).
if branch_exists "$BRANCH"; then
  OTHER_WT="$(find_worktree_for_branch "$BRANCH")"
  if [[ -n "$OTHER_WT" ]]; then
    WT_ROOT="$REPO_ROOT/.claude/worktrees"
    if [[ "$OTHER_WT" == "$WT_ROOT"/* ]]; then
      log "falling back to existing worktree $OTHER_WT for $NAME (branch $BRANCH)"
      echo "$OTHER_WT"
      exit 0
    fi
    die "branch $BRANCH is already checked out at $OTHER_WT (outside $WT_ROOT)"
  fi
fi

# ---- Create ----

mkdir -p "$(dirname "$WT_PATH")"

if branch_exists "$BRANCH"; then
  # Branch exists (likely from a previous day for feat/hotfix) — attach without -b.
  git -C "$REPO_ROOT" worktree add "$WT_PATH" "$BRANCH" >&2
  log "attached worktree $WT_PATH to existing branch $BRANCH"
else
  # Fresh branch — need an up-to-date BASE.
  git -C "$REPO_ROOT" fetch origin --quiet >&2 || \
    echo "worktree-create hook: git fetch failed, continuing with local refs" >&2

  if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE" >/dev/null; then
    echo "worktree-create hook: base $BASE not found, falling back to origin/HEAD" >&2
    BASE="$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo HEAD)"
  fi

  git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WT_PATH" "$BASE" >&2
  log "created new branch $BRANCH at $WT_PATH from $BASE"
fi

# stdout = the absolute worktree path Claude Code should chdir into.
echo "$WT_PATH"
