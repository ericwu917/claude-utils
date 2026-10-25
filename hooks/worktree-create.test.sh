#!/usr/bin/env bash
# Fixture tests for worktree-create.sh: feed WorktreeCreate stdin, check which
# commit the new worktree starts from.
#   ./hooks/worktree-create.test.sh
# Runs with a throwaway HOME so the hook's log doesn't land in ~/.claude.

set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd -P)/worktree-create.sh"
T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.claude"
g() { git -c user.name=t -c user.email=t@t "$@"; }

# origin/HEAD = the pushed commit; main is one local commit ahead of it, and
# the parent worktree's branch one more ahead — three distinct commits.
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/repo" 2>/dev/null
g -C "$T/repo" commit -q --allow-empty -m pushed
git -C "$T/repo" push -q origin HEAD 2>/dev/null
git -C "$T/repo" remote set-head origin -a >/dev/null
g -C "$T/repo" commit -q --allow-empty -m local
PARENT="$T/repo/.claude/worktrees/parent"
git -C "$T/repo" worktree add -q -b parent "$PARENT"
g -C "$PARENT" commit -q --allow-empty -m parent-only

ORIGIN_HEAD="$(git -C "$T/repo" rev-parse origin/HEAD)"
MAIN_HEAD="$(git -C "$T/repo" rev-parse HEAD)"
PARENT_HEAD="$(git -C "$PARENT" rev-parse HEAD)"

pass=0 fail=0
# check <name> <cwd> <expected worktree path> <expected start commit>
check() {
  local name="$1" cwd="$2" want_path="$3" want_head="$4" out got
  out="$(jq -n --arg n "$name" --arg cwd "$cwd" \
      '{hook_event_name: "WorktreeCreate", name: $n, cwd: $cwd, transcript_path: "/x.jsonl"}' \
    | HOME="$T/home" "$HOOK" 2>/dev/null)"
  got="$(git -C "$out" rev-parse HEAD 2>/dev/null)"
  if [[ "$out" == "$want_path" && "$got" == "$want_head" ]]; then pass=$((pass + 1))
  else fail=$((fail + 1)); printf 'FAIL %s (cwd=%s): path=%s head=%s, want %s at %s\n' \
    "$name" "$cwd" "$out" "$got" "$want_path" "$want_head"; fi
}

# Agent isolation from a worktree: nested under it, starts at its HEAD.
check agent-a48f4e06dee392b1a "$PARENT" "$PARENT/.claude/worktrees/agent-a48f4e06dee392b1a" "$PARENT_HEAD"
# Agent isolation from the main checkout: its HEAD, not origin/HEAD.
check agent-0123abcd "$T/repo" "$T/repo/.claude/worktrees/agent-0123abcd" "$MAIN_HEAD"
# Plain names keep origin/HEAD, including agent-<non-hex>.
check plain "$PARENT" "$PARENT/.claude/worktrees/plain" "$ORIGIN_HEAD"
check agent-xyz "$T/repo" "$T/repo/.claude/worktrees/agent-xyz" "$ORIGIN_HEAD"

echo "pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
