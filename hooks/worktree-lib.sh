#!/usr/bin/env bash
# Shared helpers for worktree-create.sh and worktree-remove.sh.
#
# Sourced via `source "$(dirname "${BASH_SOURCE[0]}")/worktree-lib.sh"`.
# No side effects on source — only function definitions and a default LOG.
#
# Callers are expected to:
#   - set STDIN_JSON before calling jq_first
#   - pass an absolute repo path to the git-touching helpers (create uses
#     $REPO_ROOT from `git rev-parse --show-toplevel`; remove uses $MAIN_REPO
#     resolved from `git worktree list --porcelain` because its cwd is the
#     worktree being deleted).

: "${LOG:=$HOME/.claude/worktree-hook.log}"

log() { printf '%s\n' "$*" >> "$LOG"; }

# Return first non-empty value among the jq paths given, operating on
# $STDIN_JSON. Empty string if none match.
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

# Print worktree path holding BRANCH in REPO, empty if none.
find_worktree_for_branch() {
  local repo="$1" br="$2"
  git -C "$repo" worktree list --porcelain | awk -v target="refs/heads/$br" '
    /^worktree / { path = substr($0, 10) }
    $1 == "branch" && $2 == target { print path; exit }
  '
}

# Print branch at worktree PATH in REPO; empty if detached or unregistered.
branch_at_worktree_path() {
  local repo="$1" path="$2"
  git -C "$repo" worktree list --porcelain | awk -v target="$path" '
    /^worktree / { cur = substr($0, 10) }
    $1 == "branch" && cur == target { sub(/^refs\/heads\//, "", $2); print $2; exit }
  '
}

# Exit 0 if PATH is a registered worktree in REPO.
is_registered_worktree() {
  local repo="$1" path="$2"
  git -C "$repo" worktree list --porcelain | awk -v target="$path" '
    /^worktree / { if (substr($0, 10) == target) { found = 1; exit } }
    END { exit !found }
  '
}

# Exit 0 if BRANCH exists locally in REPO.
branch_exists() {
  local repo="$1" br="$2"
  git -C "$repo" show-ref --verify --quiet "refs/heads/$br"
}

# Print newest branch matching <prefix>/<6-digit>-<REST>, empty if none.
# The 6-digit guard prevents a human-created branch like feat/cleanup-foo
# from being silently reused for input `feat/foo`.
find_existing_dated_branch() {
  local repo="$1" prefix="$2" rest="$3" ref suffix
  while IFS= read -r ref; do
    suffix="${ref#"$prefix/"}"
    if [[ "$suffix" =~ ^[0-9]{6}- ]] && [[ "${suffix#??????-}" == "$rest" ]]; then
      printf '%s\n' "$ref"
      return 0
    fi
  done < <(git -C "$repo" for-each-ref \
              --sort=-committerdate \
              --format='%(refname:short)' \
              "refs/heads/$prefix/*" 2>/dev/null)
}

# Reject name segments that could escape the worktrees root or bleed into
# another path component. `/` turns a single name into a nested path, `..`
# climbs out of .claude/worktrees/. Git's own branch-name validation
# rejects most of these downstream, but guarding explicitly here keeps
# path safety independent of git's rules drifting.
#
# Exit 0 if safe, 1 if not. Empty is also rejected.
is_safe_name_segment() {
  local s="$1"
  [[ -n "$s" ]] || return 1
  [[ "$s" == */* ]] && return 1
  [[ "$s" == *..* ]] && return 1
  return 0
}

# Resolve the worktree path for a name given during WorktreeRemove.
# Strategy:
#   1. If NAME is the default layout (.claude/worktrees/<NAME>), use that.
#   2. Otherwise try feat/<NAME> and hotfix/<NAME> via the same
#      find_existing_dated_branch + find_worktree_for_branch pair that
#      worktree-create.sh uses, so both sides stay in sync on what
#      "the branch for this name" means.
# Empty output if nothing resolved.
resolve_worktree_from_name() {
  local repo="$1" worktrees_root="$2" name="$3" prefix rest br wt
  if [[ -d "$worktrees_root/$name" ]]; then
    printf '%s\n' "$worktrees_root/$name"
    return 0
  fi
  for prefix in feat hotfix; do
    rest="${name#${prefix}/}"
    # Only probe the prefix matching the input (or unprefixed name for
    # both, as a looser fallback). Reject unsafe segments upfront.
    if [[ "$name" == "${prefix}/"* ]] || [[ "$name" != */* ]]; then
      is_safe_name_segment "$rest" || continue
      br="$(find_existing_dated_branch "$repo" "$prefix" "$rest")" || true
      [[ -n "$br" ]] || continue
      wt="$(find_worktree_for_branch "$repo" "$br")" || true
      if [[ -n "$wt" && -d "$wt" ]]; then
        printf '%s\n' "$wt"
        return 0
      fi
    fi
  done
  return 0
}
