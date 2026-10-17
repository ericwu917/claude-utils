#!/usr/bin/env bash
# PreToolUse guard (Bash): confirm recursive `rm`, except inside the session
# scratchpad.
#
# Replaces the settings rules `permissions.ask: ["Bash(rm -r:*)", "Bash(rm -rf:*)"]`.
# Those can't be narrowed: ask beats allow, and a hook's "allow" doesn't
# override a matching ask rule either (permissions docs). So the gate has to
# live here, and the two rules must be removed from settings.json.
#
# Verdicts:
#   - no recursive rm in the command           → silent (normal permission flow)
#   - every recursive rm provably inside the
#     scratchpad, and nothing else in the line  → allow
#   - same, but other subcommands alongside     → silent (those go through the
#                                                  normal flow / auto classifier)
#   - anything else                             → ask
#
# "Recursive" = any flag containing r/R (-r, -rf, -fr, -Rf, -rvf, -f -r) or
# --recursive. "Provably inside" = the segment starts with `rm` itself, every
# target is free of $ ` ( ) < > ~ and `..` (after expanding literal variables
# set earlier in the command), and the canonicalized path lies strictly under
# scratchpad_dir (from stdin; CC ≥ 2.1.257). A relative target is resolved
# against every directory the shell could be in at that point (see cd below).
#
# Contract notes (non-obvious):
#   - Fails CLOSED, the opposite of guard-worktree-edits.sh: anything it can't
#     parse (unbalanced quotes, `xargs rm -rf`, `for … do rm -rf $d`, sudo,
#     no scratchpad_dir) asks. A hook timeout can't be caught, though — CC
#     then runs the normal flow — and CC's own matcher sees into subshells and
#     $(…) better than this line-splitter, so this is a heuristic, not a wall.
#     rm on critical paths (/, ~ …) is still prompted by CC itself in every mode.
#   - `git rm -r` is left alone (recoverable, and the old rules ignored it too).
#   - stdout is empty or one JSON object; diagnostics go to $LOG only.
#   - Runs on every Bash call: one jq pass, and commands without the word `rm`
#     exit before any further work.

# No `set -u`: macOS /bin/bash 3.2 treats "${empty[@]}" as unbound and would
# abort with empty stdout — i.e. fail OPEN.
set -o pipefail

LOG="$HOME/.claude/rm-guard.log"
# 1 = log every command that contains the word rm (ALLOW / ASK / SILENT, with
# the command) — on during the break-in period, to tune the rules from real
# traffic; 0 = log only asks.
DEBUG=1

STDIN_JSON="$(cat)"
CMD="" CWD="" SP=""

# $1 = ALLOW|ASK|SILENT, $2 = reason text. SILENT emits nothing (normal flow).
verdict() {
  if [[ "$1" == ASK || "$DEBUG" == 1 ]]; then
    {
      printf '%s %s %s\n' "$(date -Iseconds)" "$1" "${2%%$'\n'*}"
      printf '  cwd=%s\n  scratchpad=%s\n  cmd=%s\n' "${CWD:-?}" "${SP:-?}" "${CMD:0:2000}"
    } >> "$LOG" 2>/dev/null
  fi
  [[ "$1" == SILENT ]] && exit 0
  local decision=ask; [[ "$1" == ALLOW ]] && decision=allow
  if ! jq -n --arg d "$decision" --arg r "$2" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: $d,
      permissionDecisionReason: $r
    }
  }' 2>/dev/null; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"guard-rm: recursive rm"}}\n'
  fi
  exit 0
}

# Cheap pre-filter on the raw JSON. Only a substring test: in JSON a newline is
# the two chars `\n`, so a word-boundary regex here would miss "…\nrm -rf".
[[ "$STDIN_JSON" == *rm* ]] || exit 0

# One jq pass; NUL-separated so a multi-line command survives `read`.
{ IFS= read -r -d '' CWD; IFS= read -r -d '' SP; IFS= read -r -d '' CMD; } < <(
  printf '%s' "$STDIN_JSON" | jq -j '(.cwd // ""), "\u0000", (.scratchpad_dir // ""), "\u0000", (.tool_input.command // ""), "\u0000"' 2>/dev/null
)
[[ -n "$CMD" ]] || verdict ASK "guard-rm: could not read the Bash command from the hook input."
[[ -n "$CWD" ]] || CWD="$PWD"

RM_WORD='(^|[^[:alnum:]_.-])rm([^[:alnum:]_.-]|$)'
[[ "$CMD" =~ $RM_WORD ]] || exit 0

# Same canonicalization as guard-worktree-edits.sh: resolve symlinks and `..`
# on the existing leading portion, re-append the missing tail. $2 = base dir
# for a relative path (default: the session cwd).
canon() {
  local p="$1" dir base
  [[ "$p" = /* ]] || p="${2:-$CWD}/$p"
  if [[ -d "$p" ]]; then ( cd "$p" 2>/dev/null && pwd -P ); return; fi
  dir="$(dirname "$p")"; base="$(basename "$p")"
  while [[ ! -d "$dir" && "$dir" != "/" && "$dir" != "." ]]; do
    base="$(basename "$dir")/$base"; dir="$(dirname "$dir")"
  done
  if [[ -d "$dir" ]]; then printf '%s/%s\n' "$(cd "$dir" && pwd -P)" "$base"
  else printf '%s\n' "$p"; fi
}

[[ -n "$SP" ]] && SP="$(cd "$SP" 2>/dev/null && pwd -P || printf '%s' "$SP")"

# Drop heredoc bodies: they are data, not commands (a body line `T=/` or
# "rm -rf …" in a commit message must not count). More than one heredoc on a
# line is beyond this scan → stop trusting variables (NOVARS).
NOVARS=0 S="" delim="" dash=""
HEREDOC='(^|[^<])<<(-?)[[:space:]]*['\''"]?([A-Za-z_][A-Za-z0-9_]*)'
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -n "$delim" ]]; then
    chk="$line"; [[ -n "$dash" ]] && chk="${chk#"${chk%%[!$'\t']*}"}"
    [[ "$chk" == "$delim" ]] && delim=""
    continue
  fi
  S+="$line"$'\n'
  if [[ "$line" =~ $HEREDOC ]]; then
    dash="${BASH_REMATCH[2]}" delim="${BASH_REMATCH[3]}"
    rest="${line#*<<}"; [[ "$rest" == *'<<'* ]] && NOVARS=1
  fi
done <<< "$CMD"

# Split into statements on newline and ;, each into subcommands on && || | &
# — outside quotes only (grep -E "a|rm -r|b" is one command), honouring
# backslash escapes. The harmless redirects Claude tacks on go first, or their
# & would split the rm segment. CONDS[i]=1 when SEGS[i] is part of a
# multi-part statement, i.e. runs conditionally, so an assignment there
# doesn't count. OPS[i] = the operator before SEGS[i] (";" = statement start).
for r in '2>&1' '&>/dev/null' '2>/dev/null' '>/dev/null'; do S="${S//"$r"/}"; done
SEGS=() CONDS=() OPS=()
q="" cur="" nst=0 n=${#S} k=0 op=";"
end_seg() { SEGS+=("$cur"); CONDS+=(0); OPS+=("$op"); cur=""; nst=$((nst + 1)); }
end_stmt() {
  end_seg
  if [[ $nst -gt 1 ]]; then local j; for ((j = ${#SEGS[@]} - nst; j < ${#SEGS[@]}; j++)); do CONDS[j]=1; done; fi
  nst=0
}
while [[ $k -lt $n ]]; do
  c="${S:k:1}"
  if [[ "$q" == "'" ]]; then [[ "$c" == "'" ]] && q=""; cur+="$c"
  elif [[ "$c" == "\\" ]]; then cur+="${S:k:2}"; k=$((k + 1))
  elif [[ "$q" == '"' ]]; then [[ "$c" == '"' ]] && q=""; cur+="$c"
  elif [[ "$c" == "'" || "$c" == '"' ]]; then q="$c"; cur+="$c"
  elif [[ "$c" == ';' || "$c" == $'\n' ]]; then end_stmt; op=";"
  elif [[ "$c" == '&' || "$c" == '|' ]]; then
    sep="$c"
    if [[ "${S:k+1:1}" == "$c" ]]; then sep="$c$c"; k=$((k + 1))
    elif [[ "$c" == '|' && "${S:k+1:1}" == '&' ]]; then k=$((k + 1)); fi
    end_seg; op="$sep"
  else cur+="$c"; fi
  k=$((k + 1))
done
end_stmt

# Quote-aware word split into TOKS without executing anything; 1 = unbalanced quotes.
split_words() {
  local words t
  words="$(printf '%s' "$1" | xargs printf '%s\n' 2>/dev/null)" || return 1
  TOKS=()
  while IFS= read -r t; do TOKS+=("$t"); done <<< "$words"
}

# Variables set to a literal by an unconditional `NAME=value` statement earlier
# in this command. Parallel arrays (macOS /bin/bash 3.2 has no assoc arrays).
VN=() VV=()
var_del() {
  local i
  for i in "${!VN[@]}"; do [[ "${VN[$i]}" == "$1" ]] && unset 'VN[i]' 'VV[i]'; done
}
var_get() {
  local i
  for i in "${!VN[@]}"; do [[ "${VN[$i]}" == "$1" ]] && { printf '%s' "${VV[$i]}"; return 0; }; done
  return 1
}
# Expand $NAME / ${NAME} from the table; 1 = a variable it doesn't know.
expand_vars() {
  local t="$1" n v
  while [[ "$t" =~ \$\{?([A-Za-z_][A-Za-z0-9_]*)\}? ]]; do
    n="${BASH_REMATCH[1]}"
    v="$(var_get "$n")" || return 1
    # shellcheck disable=SC2016  # literal ${ … }
    if [[ "${BASH_REMATCH[0]}" == '${'*'}' ]]; then t="${t/"\${$n}"/$v}"; else t="${t/"\$$n"/$v}"; fi
  done
  printf '%s' "$t"
}

# rm, then only flags up to a recursive one ("rm x; read -r" doesn't count).
NESTED_REC_RM='(^|[^[:alnum:]_.-])rm([[:space:]]+-[^[:space:]]*)*[[:space:]]+(-[[:alpha:]]*[rR][[:alpha:]]*|--recursive)([^[:alnum:]_-]|$)'
ASSIGN='^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*='
NOT_LITERAL='[[:space:]$`()]'
# shellcheck disable=SC2016  # regex, not an expansion
NAME_PRE='(^|[^A-Za-z0-9_${])' NAME_POST='([^A-Za-z0-9_]|$)'   # a bare mention, not $NAME / ${NAME}
CD_WORD='(^|[^[:alnum:]_.-])(cd|pushd|popd)([^[:alnum:]_.-]|$)'
SAFE=0 OTHER=0

# Where the shell can be when a segment runs. `cd X && … && rm rel`: rm only
# runs if cd succeeded, so rel resolves against X alone (CHAIN; valid while
# every operator since the statement start is &&). Anywhere else — after `;`,
# `||`, `|`, `&` — cd may or may not have happened, so rel must be inside for
# every dir seen so far (POSS). A cd this can't follow (pushd, `(cd …`, a
# non-literal or `-` arg) sets DIRUNK and every later relative target asks.
POSS=("$(cd "$CWD" 2>/dev/null && pwd -P || printf '%s' "$CWD")")
CHAIN="" ALLAND=1 DIRUNK=0

for i in "${!SEGS[@]}"; do
  seg="${SEGS[$i]}" cond="${CONDS[$i]}" sop="${OPS[$i]}"
  if [[ "$sop" == ";" ]]; then ALLAND=1 CHAIN=""
  elif [[ "$sop" != "&&" ]]; then ALLAND=0; fi
  if [[ $ALLAND == 1 && -n "$CHAIN" ]]; then DIRS=("$CHAIN"); else DIRS=("${POSS[@]}"); fi
  [[ "$seg" =~ [^[:space:]] ]] || continue

  if [[ "$seg" =~ $CD_WORD ]]; then
    if [[ "$seg" =~ ^[[:space:]]*cd([[:space:]]|$) ]]; then
      X=""
      if split_words "$seg"; then
        args=("${TOKS[@]:1}")
        [[ "${args[0]}" == -[LP] ]] && args=("${args[@]:1}")
        if [[ ${#args[@]} -eq 0 || -z "${args[0]}" ]]; then X="$HOME"
        elif [[ ${#args[@]} -eq 1 ]]; then
          a="${args[0]}" ok=1
          if [[ "$a" == *'$'* ]]; then a="$(expand_vars "$a")" || ok=0; fi
          case "$a" in -*|*'`'*|*'('*|*')'*|*'$'*|'~'*) ok=0 ;; esac
          [[ $ok == 1 && ( "$a" == /* || ${#DIRS[@]} -eq 1 ) ]] && X="$(canon "$a" "${DIRS[0]}")"
          [[ "$X" == *'/..'* ]] && X=""
        fi
      fi
      if [[ -n "$X" ]]; then POSS+=("$X"); CHAIN="$X"; continue; fi   # a plain cd runs nothing
      DIRUNK=1; OTHER=$((OTHER + 1)); continue
    fi
    DIRUNK=1   # pushd / popd / (cd … / a cd inside something else
  fi

  # Any other mention of a tracked name (unset, read, for, export, a
  # conditional or non-literal reassignment) → its value is no longer known.
  if [[ ${#VN[@]} -gt 0 ]]; then
    for n in "${VN[@]}"; do
      [[ "$seg" =~ $NAME_PRE$n$NAME_POST ]] && var_del "$n"
    done
  fi
  if [[ "$seg" =~ $ASSIGN ]]; then
    if split_words "$seg" && [[ ${#TOKS[@]} -eq 1 ]]; then
      n="${TOKS[0]%%=*}" v="${TOKS[0]#*=}"
      var_del "$n"
      # G=$W/sub: expand variables this table already knows (else stays non-literal).
      [[ "$v" == *'$'* ]] && v="$(expand_vars "$v")"
      # A literal assignment runs nothing, so it doesn't stop an ALLOW.
      if [[ $cond == 0 && $NOVARS == 0 && -n "$v" && ! "$v" =~ $NOT_LITERAL ]]; then
        VN+=("$n"); VV+=("$v"); continue
      fi
      OTHER=$((OTHER + 1)); continue
    fi
  fi

  if ! [[ "$seg" =~ $RM_WORD ]]; then OTHER=$((OTHER + 1)); continue; fi

  if ! split_words "$seg"; then
    # Unparseable, but no "rm … -r" in sight → not a recursive rm.
    [[ "$seg" =~ $NESTED_REC_RM ]] || { OTHER=$((OTHER + 1)); continue; }
    verdict ASK "guard-rm: could not parse this rm command, please confirm:
  $seg"
  fi

  first="${TOKS[0]:-}"
  if [[ "$first" != rm && "$first" != /bin/rm ]]; then
    [[ "$first" == git ]] && { OTHER=$((OTHER + 1)); continue; }
    # A search pattern like grep 'rm -r' is data — unless a substitution
    # could run something.
    # shellcheck disable=SC2016  # literal $(
    if [[ "$first" =~ ^(grep|egrep|fgrep|rg)$ && "$seg" != *'$('* && "$seg" != *'`'* ]]; then
      OTHER=$((OTHER + 1)); continue
    fi
    # rm somewhere inside (xargs, sudo, do, $(…), -exec, bash -c "…") followed
    # by a recursive flag → can't vouch for it. Matched on the raw text, so a
    # quoted "rm -rf" (echo, grep pattern) asks too; `grep -r rm .` doesn't.
    [[ "$seg" =~ $NESTED_REC_RM ]] && verdict ASK "guard-rm: recursive rm in a form this guard can't check, please confirm:
  $seg"
    OTHER=$((OTHER + 1)); continue
  fi

  rec=0 opts=1 TARGETS=()
  for t in "${TOKS[@]:1}"; do
    if [[ $opts == 1 && "$t" == -- ]]; then opts=0
    elif [[ $opts == 1 && "$t" == --recursive ]]; then rec=1
    elif [[ $opts == 1 && "$t" == -?* && "$t" != --* ]]; then [[ "$t" == *[rR]* ]] && rec=1
    elif [[ $opts == 1 && "$t" == --* ]]; then :
    else TARGETS+=("$t"); fi
  done
  if [[ $rec == 0 ]]; then OTHER=$((OTHER + 1)); continue; fi

  [[ -n "$SP" ]] || verdict ASK "guard-rm: recursive rm and no scratchpad_dir in the hook input, please confirm:
  $seg"
  [[ ${#TARGETS[@]} -gt 0 ]] || verdict ASK "guard-rm: recursive rm without explicit targets, please confirm:
  $seg"
  for t in "${TARGETS[@]}"; do
    bad=""
    if [[ "$t" == *'$'* ]]; then
      t="$(expand_vars "$t")" || bad="uses a variable not set to a literal earlier in this command"
    fi
    [[ -n "$bad" ]] || case "$t" in
      *'$'*|*'`'*|*'('*|*')'*|*'<'*|*'>'*|'~'*|*..*) bad="contains \$ \` ( ) < > ~ or .." ;;
    esac
    [[ -z "$bad" && "$t" != /* && $DIRUNK == 1 ]] && bad="relative path after a cd this guard can't follow"
    if [[ -z "$bad" ]]; then
      for d in "${DIRS[@]}"; do
        abs="$(canon "$t" "$d")"
        [[ "$abs" == "$SP/"?* ]] || { bad="outside the scratchpad ($abs)"; break; }
        [[ "$t" == /* ]] && break
      done
    fi
    [[ -n "$bad" ]] && verdict ASK "guard-rm: recursive rm target $bad. Please confirm:
  $seg"
  done
  SAFE=$((SAFE + 1))
done

[[ $SAFE -gt 0 && $OTHER -eq 0 ]] && verdict ALLOW "guard-rm: recursive rm inside the session scratchpad"
verdict SILENT "scratchpad-rm=$SAFE other=$OTHER"
