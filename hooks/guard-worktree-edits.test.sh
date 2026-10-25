#!/usr/bin/env bash
# Fixture tests for guard-worktree-edits.sh: feed PreToolUse stdin, check the
# verdict and what lands in the log.
#   ./hooks/guard-worktree-edits.test.sh
# Runs with a throwaway HOME so the hook's log doesn't land in ~/.claude.

set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd -P)/guard-worktree-edits.sh"
# NOT under /tmp, /private/tmp or /var/folders: the hook always allows those,
# which would make every case below pass trivially.
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"; mkdir -p "$CACHE"
T="$(cd "$(mktemp -d "$CACHE/guard-worktree-edits.XXXXXX")" && pwd -P)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.claude" "$T/cfg" "$T/other" "$T/plain"
git init -q "$T/repo"
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
mkdir -p "$T/repo/.claude/worktrees"
git -C "$T/repo" worktree add -q -b wt "$T/repo/.claude/worktrees/wt"
LOG="$T/home/.claude/worktree-guard.log"

pass=0 fail=0
# check <expected allow|ask> <target> [cwd] [CLAUDE_CONFIG_DIR]
check() {
  local want="$1" target="$2" cwd="${3:-$T/repo}" cfg="${4-}" out got
  out="$(jq -n --arg f "$target" --arg cwd "$cwd" '{
      hook_event_name: "PreToolUse", tool_name: "Edit", cwd: $cwd,
      tool_input: { file_path: $f } }' \
    | HOME="$T/home" CLAUDE_CONFIG_DIR="$cfg" TMPDIR=/nonexistent "$HOOK")"
  if [[ -z "$out" ]]; then got=allow
  else got="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision')"; fi
  if [[ "$got" == "$want" ]]; then pass=$((pass + 1))
  else fail=$((fail + 1)); printf 'FAIL want=%s got=%s: %s (cwd=%s cfg=%s)\n' "$want" "$got" "$target" "$cwd" "$cfg"; fi
}
# logged <expected yes|no> <label> — did the last call append a record?
logged() {
  local want="$1" n got=no
  n=0; [[ -f "$LOG" ]] && n="$(wc -l < "$LOG")"
  [[ "$n" -gt "${LAST_N:-0}" ]] && got=yes
  LAST_N="$n"
  if [[ "$got" == "$want" ]]; then pass=$((pass + 1))
  else fail=$((fail + 1)); printf 'FAIL log want=%s got=%s: %s\n' "$want" "$got" "$2"; fi
}
LAST_N=0

# Inside the active tree → allow, not logged.
check allow "$T/repo/src/a.txt";                  logged no in-root
check allow "src/a.txt";                          logged no in-root-relative
check allow "$T/repo/.claude/worktrees/wt/b.txt" "$T/repo/.claude/worktrees/wt"; logged no in-root-worktree

# Crossing trees → ask, logged.
check ask "$T/other/x.txt";                       logged yes outside
check ask "$T/repo/.claude/worktrees/wt/b.txt";   logged yes main-to-worktree
check ask "$T/repo/src/a.txt" "$T/repo/.claude/worktrees/wt"; logged yes worktree-to-main

# Main repo's own .claude/ from a worktree → allow, logged (main-claude).
check allow "$T/repo/.claude/skills/s.md" "$T/repo/.claude/worktrees/wt"; logged yes main-claude

# Global config: ~/.claude always; $CLAUDE_CONFIG_DIR only when set. Not logged.
check allow "$T/home/.claude/CLAUDE.md";          logged no home-claude
check allow "$T/cfg/CLAUDE.md" "$T/repo" "$T/cfg"; logged no config-dir
check ask "$T/cfg/CLAUDE.md" "$T/repo" "";        logged yes config-dir-unset
check ask "$T/cfgx/CLAUDE.md" "$T/repo" "$T/cfg"; logged yes config-dir-prefix-only

# Temp dirs → allow, not logged.
check allow "/private/tmp/x.txt";                 logged no tmp

# Not a git repo → allow, logged.
check allow "$T/other/x.txt" "$T/plain";          logged yes not-git

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
