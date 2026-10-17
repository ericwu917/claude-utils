#!/usr/bin/env bash
# Fixture tests for guard-rm.sh: feed PreToolUse stdin, check the verdict.
#   ./hooks/guard-rm.test.sh
# Runs with a throwaway HOME so the hook's log doesn't land in ~/.claude.

set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd -P)/guard-rm.sh"
# Under /private/tmp like the real scratchpad, so /tmp/… is a genuine alias.
T="$(mktemp -d /private/tmp/guard-rm.XXXXXX)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.claude" "$T/scratch/sub" "$T/repo"
ln -s "$T/repo" "$T/scratch/link"
SP="$T/scratch"
SP_TMP="${SP/#\/private\/tmp//tmp}"   # same dir via the /tmp symlink

pass=0 fail=0
# check <expected allow|ask|silent> <command> [scratchpad_dir] [cwd]
check() {
  local want="$1" cmd="$2" sp="${3-$SP}" cwd="${4:-$T/repo}" out got
  out="$(jq -n --arg c "$cmd" --arg sp "$sp" --arg cwd "$cwd" '{
      hook_event_name: "PreToolUse", tool_name: "Bash", cwd: $cwd,
      tool_input: { command: $c } } + (if $sp == "" then {} else { scratchpad_dir: $sp } end)' \
    | HOME="$T/home" "$HOOK")"
  if [[ -z "$out" ]]; then got=silent
  else got="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision')"; fi
  if [[ "$got" == "$want" ]]; then pass=$((pass + 1))
  else fail=$((fail + 1)); printf 'FAIL want=%s got=%s: %s\n' "$want" "$got" "$cmd"; fi
}

# Not a recursive rm → normal flow.
check silent "ls -la"
check silent "rm -f /etc/hosts.bak"
check silent "git rm -r --cached build"
check silent "grep -r rm ."
check silent "echo 'rm -f x'"
check silent "npm run format"
check silent "grep -n -B2 -A4 'rm -r' ~/.claude/settings.json"
check silent "rg 'rm -rf' hooks/"
check silent "IMPL=/x
grep -n -E \"PRD_REPO|cp -R|mv |rm -r|target/prd\" \$IMPL/tools/codegen.sh | head -50"
check silent "grep 'a; rm -rf /x' f | wc -l"
check silent "bash -c 'echo rm x; read -r -a A <<< y'"
check silent "rm -f /tmp/x; bash -c 'S=\$'\"'\"'rm x'\"'\"''"

# Inside the scratchpad → allow.
check allow "rm -rf $SP/sub"
check allow "rm -r $SP/sub/a $SP/sub/b"
check allow "rm -fr \"$SP/sub\""
check allow "rm -R -f -- $SP/sub"
check allow "rm --recursive $SP/sub"
check allow "rm -rf $SP/*"
check allow "rm -rf $SP/sub 2>/dev/null"
check allow "rm -rf $SP_TMP/sub"
check allow "rm -rf sub" "$SP" "$SP"
check allow $'rm -rf '"$SP/sub"$'\n'

# Scratchpad rm mixed with other subcommands → normal flow decides the rest.
check silent "rm -rf $SP/sub && mkdir -p $SP/sub"

# cd is followed: `cd X && rm rel` resolves against X; after `;` or `||`
# both the old dir and X must be inside.
check allow "cd $SP/sub && rm -rf x"
check allow "cd $SP && cd sub && rm -rf x"
check allow "S=$SP; cd \$S && rm -rf x"
check allow "cd $SP/sub; rm -rf x" "$SP" "$SP"
check silent "cd $SP/sub && rm -rf target; mvn -o -q test 2>&1 | tail -20; grep -E 'PASS|FAIL' target/matrix.txt"
check ask "cd $SP/sub; rm -rf x"
check ask "cd $SP || rm -rf x"
check ask "cd $SP | rm -rf x"
check ask "cd $T/repo && rm -rf x"
check ask "cd $SP && cd .. && rm -rf x"
check ask "cd $SP && cd ../.. && rm -rf x"
check ask "cd $SP && rm -rf x; rm -rf y"
check ask "pushd $SP && rm -rf x"
check ask "cd - && rm -rf x"
check ask "cd \$X && rm -rf x"
check ask "(cd $SP && rm -rf x)"
check ask "cd $SP && (cd /; rm -rf x)"
check ask "cd ~ && rm -rf x"
check ask "true || cd $SP && rm -rf x"
check ask "cd $SP && false || rm -rf x"
check ask "rm -rf cd"
check ask "rm -rf $SP/x cd"

# A variable assigned a literal earlier in the same command is resolved.
check allow "T=$SP/sub; rm -rf \"\$T\""
check allow $'T='"$SP"$'\nrm -rf "${T}/sub" $T/x'
check silent "T=$SP/trio; rm -rf \"\$T\"; mkdir -p \"\$T/repo\"; cat > \"\$T/a.md\" <<'EOF'
# A
rm -rf /
T=/
EOF
git -C \"\$T/repo\" add a.md"
check allow "S=$SP; D=\$S/sub; rm -rf \"\$D\""
check allow "S=$SP; D=\${S}/sub; rm -rf \$D"
check ask "W=$T/repo; G=\$W/x; rm -r \"\$G\""
check ask "D=\$S/sub; rm -rf \$D"
check ask "S=$SP; D=\$(echo \$S); rm -rf \$D"
check ask "T=$SP; T=\$T/../repo; rm -rf \$T"
check ask "T=$T/repo; rm -rf \"\$T\""
check ask "T=; rm -rf \$T/x"
check ask "T=\$(mktemp -d); rm -rf \"\$T\""
check ask "T=$SP/sub; true && T=/; rm -rf \$T"
check ask "true && T=$SP/sub; rm -rf \$T"
check ask "T=$SP/sub; unset T; rm -rf \$T/x"
check ask "T=$SP/sub; read T; rm -rf \$T"
check ask "T=$SP/sub; rm -rf \$TX"
check ask "rm -rf \$T; T=$SP/sub"
check ask "T=\"$SP/a $T/repo\"; rm -rf \$T"
check ask "cat <<EOF
T=$SP/sub
EOF
rm -rf \$T"

# Everything else → ask.
check ask "rm -rf $T/repo"
check ask "rm -rf $SP"
check ask "rm -rf $SP/../repo"
check ask "rm -rf $SP/link/"
check ask "rm -rf \$HOME/x"
check ask "rm -rf ~/x"
check ask "rm -rf build"
check allow "cd $SP && rm -rf sub" "$SP" "$SP"
check ask "rm -rf $SP/sub; rm -rf $T/repo"
check ask "ls && rm -Rf $T/repo"
check ask "rm -rf $SP/sub" ""
check ask "rm -rf"
check ask "sudo rm -rf $SP/sub"
check ask "find . -name x | xargs rm -rf"
check ask "for d in a b; do rm -rf \$d; done"
check ask "echo \$(rm -rf $SP/sub)"
check ask "rm -rf '$SP/sub"
check ask $'ls\nrm -rf '"$T/repo"
check ask $'ls &&\n\trm -rf '"$T/repo"
check ask "cd;rm -rf sub" "$SP" "$SP"
check ask "cd&&rm -rf sub" "$SP" "$SP"
check ask "bash -c \"rm -rf $SP/sub\""
check ask "eval 'rm -rf $SP/sub'"
check ask "echo 'rm -rf /'"
check ask "grep x \$(rm -rf $T/repo)"
check ask "grep -r x . | xargs rm -rf"
check ask "echo \"a\" && rm -rf $T/repo"
check ask "echo \"a|b\";rm -rf $T/repo"
check ask "ls \\; rm -rf $T/repo"

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
