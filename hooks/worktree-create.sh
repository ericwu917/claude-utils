#!/usr/bin/env bash
# WorktreeCreate hook: creates or reuses a git worktree with a date-stamped branch.
#
#   Input (stdin JSON): Claude Code's WorktreeCreate payload. The worktree
#   name field location isn't fully documented, so we probe multiple paths.
#
#   Naming convention (on first creation):
#     input name      branch                            path under .claude/worktrees/
#     feat/<rest>     feat/<YYMMDD>-<rest>   (develop)  feat/<YYMMDD>-<rest>/
#     feature/<rest>  feature/<YYMMDD>-<rest> (develop) feature/<YYMMDD>-<rest>/
#     hotfix/<rest>   hotfix/<YYMMDD>-<rest> (master)   hotfix/<YYMMDD>-<rest>/
#     <slug> *        claude/<YYMMDD>-<slug> (HEAD)     <YYMMDD>-<slug>/  (desktop auto-name)
#     <other>         worktree-<name>        (HEAD)     <name>/    (matches CC default)
#
#   * <slug> = a desktop-generated docker-style name (empty transcript_path +
#     word-word[-hex6], e.g. sad-tharp-abb433). A name you TYPE on the CLI rides
#     a real session, so it takes the plain <other> row even if it looks slug-y.
#
#   Input normalization: a leading `worktree-` prefix on the plain case is
#   stripped so `claude -w worktree-foo` (a branch name pasted from
#   `git branch`) resolves to the same worktree as `claude -w foo`.
#
#   Reuse semantics (#3):
#     - A matching feat/*-<rest> (or feature/*-, hotfix/*-<rest>) branch from any day is
#       reused in preference to stamping today's date on a new branch.
#     - If the branch exists but no worktree holds it, we attach a new
#       worktree at the standard path.
#     - If a registered worktree already exists at the standard path, we echo
#       that path and enter it, regardless of which branch it has checked out
#       (an exact path match wins — `-w` names a path).
#     - If the branch is checked out at some other path under
#       $REPO_ROOT/.claude/worktrees/ (e.g. CC's own default layout from
#       before this hook was installed, or a legacy prefixed path from an
#       earlier hook version), we fall back to that path.
#     - Error (do not mutate) when: the branch is checked out truly outside
#       our worktrees root; or the standard path exists but isn't a tracked
#       worktree.
#
#   Output (stdout): absolute path of the worktree to chdir into.
#   Non-zero exit aborts creation.

set -euo pipefail

LOG="$HOME/.claude/worktree-hook.log"
# shellcheck source=worktree-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/worktree-lib.sh"
STDIN_JSON="$(cat)"

{
  echo "=== $(date -Iseconds) ==="
  echo "$STDIN_JSON"
} >> "$LOG"

die() {
  echo "worktree-create hook: $*" >&2
  log "ERROR: $*"
  exit 1
}

# Local-scope MCP servers (`claude mcp add`'s default scope) live in
# ~/.claude.json under projects["<dir>"].mcpServers, keyed by directory, so a
# worktree — its own project entry — starts with none. Copy the parent repo's
# into the worktree's .mcp.json (project scope) so they follow it. Never write
# ~/.claude.json itself: the parent session may be rewriting it concurrently.
#
#   - Parent candidates: $REPO_ROOT, then the main repo cut from the path (when
#     the session itself sits in a .claude/worktrees/ worktree). None → no-op.
#   - Existing .mcp.json is merged; the parent's entries win on a name clash so
#     re-entering picks up changes (a new IDE port, a rotated key). A
#     hand-written entry of the same name gets overwritten; others are kept.
#   - A tracked .mcp.json is left alone: merging would dirty a tracked file
#     (and a dirty worktree survives worktree-remove.sh). Skipped + logged.
#   - An untracked one is hidden via info/exclude so it neither shows in
#     `git status` nor blocks `git worktree remove`. info/exclude lives in the
#     common gitdir, so the `/.mcp.json` line (never removed) covers the main
#     checkout and every worktree: a root .mcp.json created there is silently
#     skipped by `git add .` (needs -f), and a hand-written untracked one in any
#     worktree is deleted with it by worktree-remove.sh instead of preserved.
#   - Secrets: local scope often carries keys in env/headers. The copy sits in
#     the worktree, kept out of commits only by that exclude (`git add -f`
#     still adds it).
#
# Best-effort: returns non-zero on failure, caller logs and carries on — a
# missing MCP config must never abort worktree creation.
mirror_local_mcp_servers() {
  local wt="$1" target="$1/.mcp.json" servers exclude tmp
  servers="$(jq -c 'first(.projects[$ARGS.positional[]].mcpServers // empty | select(length > 0))' \
               "$HOME/.claude.json" --args "$REPO_ROOT" "${REPO_ROOT%%/.claude/worktrees/*}" 2>/dev/null)" \
    || return 1
  [[ -n "$servers" ]] || return 0

  if git -C "$wt" ls-files --error-unmatch .mcp.json >/dev/null 2>&1; then
    log "skip MCP mirror: $target is tracked"
    return 0
  fi

  tmp="$target.tmp.$$"
  if [[ -f "$target" ]]; then
    jq --argjson s "$servers" '.mcpServers = (.mcpServers // {}) + $s' "$target" > "$tmp"
  else
    jq -n --argjson s "$servers" '{mcpServers: $s}' > "$tmp"
  fi || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$target" || return 1

  exclude="$(git -C "$wt" rev-parse --path-format=absolute --git-path info/exclude)" || return 1
  mkdir -p "$(dirname "$exclude")" || return 1
  if ! grep -qxF '/.mcp.json' "$exclude" 2>/dev/null; then
    # No trailing newline would glue our line onto the file's last pattern.
    [[ -s "$exclude" && -n "$(tail -c1 "$exclude")" ]] && echo >> "$exclude"
    echo '/.mcp.json' >> "$exclude" || return 1
  fi

  log "mirrored local MCP servers $(jq -c keys <<<"$servers") into $target"
}

NAME="$(jq_first '.name' '.tool_input.name' '.toolInput.name' '.worktreeName' '.hookSpecificOutput.name')"
CWD="$(jq_first '.cwd')"
# Empty transcript_path is the tell-tale of a desktop-auto worktree (no session
# transcript exists yet); the create UI sends a random slug as .name. See the
# is_desktop_auto_name guard in the plain-name case below.
TRANSCRIPT="$(jq_first '.transcript_path')"

[[ -n "$NAME" ]] || die "could not extract name from stdin. See $LOG"

if [[ -n "$CWD" ]]; then
  cd "$CWD"
fi

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository (cwd=$PWD)"

REPO_ROOT="$(git rev-parse --show-toplevel)"

# ---- Resolve target BRANCH ----

TODAY="$(date +%y%m%d)"

case "$NAME" in
  feat/*|feature/*)
    # feature/ is git-flow's default spelling of feat/; same rules, and the
    # input's own prefix is kept on the branch.
    PREFIX="${NAME%%/*}"
    REST="${NAME#*/}"
    is_safe_name_segment "$REST" \
      || die "$PREFIX name '$REST' must be non-empty and must not contain '/' or '..'"
    EXISTING="$(find_existing_dated_branch "$REPO_ROOT" "$PREFIX" "$REST")"
    if [[ -n "$EXISTING" ]]; then
      BRANCH="$EXISTING"
      log "reusing existing branch $BRANCH for input $NAME"
    else
      BRANCH="${PREFIX}/${TODAY}-${REST}"
    fi
    BASE="origin/develop"
    ;;
  hotfix/*)
    REST="${NAME#hotfix/}"
    is_safe_name_segment "$REST" \
      || die "hotfix name '$REST' must be non-empty and must not contain '/' or '..'"
    EXISTING="$(find_existing_dated_branch "$REPO_ROOT" hotfix "$REST")"
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
    is_safe_name_segment "$NAME" \
      || die "plain worktree name '$NAME' must be non-empty and must not contain '/' or '..'"
    if is_desktop_auto_name "$TRANSCRIPT" "$NAME"; then
      # Desktop's worktree UI gives no chance to name the worktree, so CC sends a
      # random docker-style slug with no feat/hotfix intent. Date-stamp it under
      # the desktop's own `claude/` branch prefix so these read as hook-managed
      # and sort by day in `git branch`. As with feat/hotfix, a matching dated
      # branch from any day is reused before stamping today's date, so the
      # desktop re-entering the same slug tomorrow lands on the same worktree.
      EXISTING="$(find_existing_dated_branch "$REPO_ROOT" claude "$NAME")"
      if [[ -n "$EXISTING" ]]; then
        BRANCH="$EXISTING"
        log "reusing existing branch $BRANCH for desktop auto-name $NAME"
      else
        BRANCH="claude/${TODAY}-${NAME}"
      fi
      # Path is the flat date-stamped slug (no claude/ subdir), so it stays a
      # single clean directory under .claude/worktrees/ — the branch keeps the
      # claude/ prefix, the directory doesn't.
      WT_NAME="${BRANCH#claude/}"
    else
      BRANCH="worktree-${NAME}"
      # Align plain-name path with Claude Code's own -w default layout
      # (.claude/worktrees/<name>/). The worktree- prefix is kept on the
      # branch name only, so hook-created branches still stand out in
      # `git branch`, but the on-disk directory stays clean.
      WT_NAME="$NAME"
    fi
    BASE="$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    [[ -n "$BASE" ]] || BASE="HEAD"
    ;;
esac

WT_PATH="$REPO_ROOT/.claude/worktrees/${WT_NAME:-$BRANCH}"

# Clean up any stale registration whose directory was manually rm -rf'd.
# Idempotent; only affects entries git already considers broken.
git -C "$REPO_ROOT" worktree prune >&2 2>/dev/null || true

# ---- State dispatch ----

# (a) Standard path already occupied. If a registered worktree already sits at
# our exact target path, enter it regardless of which branch it has checked out
# — `-w` names a path, so an exact path match wins over the branch we'd have
# computed (e.g. `-w master` landing on a pre-existing worktree that holds the
# repo default branch). Only refuse if the dir exists but isn't a tracked
# worktree (leftover junk we shouldn't silently adopt).
if [[ -d "$WT_PATH" ]]; then
  is_registered_worktree "$REPO_ROOT" "$WT_PATH" || \
    die "$WT_PATH exists but isn't a tracked git worktree; please remove it manually"
  BRANCH_AT_PATH="$(branch_at_worktree_path "$REPO_ROOT" "$WT_PATH")"
  if [[ "$BRANCH_AT_PATH" == "$BRANCH" ]]; then
    log "reusing existing worktree at $WT_PATH"
  else
    log "entering existing worktree at $WT_PATH (branch ${BRANCH_AT_PATH:-detached HEAD}, not $BRANCH)"
  fi
  mirror_local_mcp_servers "$WT_PATH" || log "WARN: MCP mirror failed for $WT_PATH"
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
if branch_exists "$REPO_ROOT" "$BRANCH"; then
  OTHER_WT="$(find_worktree_for_branch "$REPO_ROOT" "$BRANCH")"
  if [[ -n "$OTHER_WT" ]]; then
    WT_ROOT="$REPO_ROOT/.claude/worktrees"
    if [[ "$OTHER_WT" == "$WT_ROOT"/* ]]; then
      log "falling back to existing worktree $OTHER_WT for $NAME (branch $BRANCH)"
      mirror_local_mcp_servers "$OTHER_WT" || log "WARN: MCP mirror failed for $OTHER_WT"
      echo "$OTHER_WT"
      exit 0
    fi
    die "branch $BRANCH is already checked out at $OTHER_WT (outside $WT_ROOT)"
  fi
fi

# ---- Create ----

mkdir -p "$(dirname "$WT_PATH")"

if branch_exists "$REPO_ROOT" "$BRANCH"; then
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

mirror_local_mcp_servers "$WT_PATH" || log "WARN: MCP mirror failed for $WT_PATH"

# stdout = the absolute worktree path Claude Code should chdir into.
echo "$WT_PATH"
