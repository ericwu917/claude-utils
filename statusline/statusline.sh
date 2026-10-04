#!/bin/bash
input=$(cat)

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
ORANGE='\033[38;5;208m'
DIM='\033[2m'
RESET='\033[0m'

# Parse JSON (single jq call)
eval "$(echo "$input" | jq -r '
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "TRANSCRIPT=\(.transcript_path // "")",
  @sh "CC_VERSION=\(.version // "")",
  @sh "MODEL=\(.model.display_name // "?")",
  @sh "DIR=\(.workspace.current_dir // ".")",
  @sh "COST=\(.cost.total_cost_usd // 0)",
  @sh "DURATION_MS=\(.cost.total_duration_ms // 0)",
  @sh "API_DURATION_MS=\(.cost.total_api_duration_ms // 0)",
  @sh "PCT=\(.context_window.used_percentage // 0 | round)",
  @sh "CTX_SIZE=\(.context_window.context_window_size // 200000)",
  @sh "INPUT_TOKENS=\(.context_window.total_input_tokens // 0)",
  @sh "OUTPUT_TOKENS=\(.context_window.total_output_tokens // 0)",
  @sh "CUR_INPUT=\(.context_window.current_usage.input_tokens // 0)",
  @sh "CUR_CACHE_CREATE=\(.context_window.current_usage.cache_creation_input_tokens // 0)",
  @sh "CUR_CACHE_READ=\(.context_window.current_usage.cache_read_input_tokens // 0)",
  @sh "FIVE_H_PCT=\(.rate_limits.five_hour.used_percentage // empty)",
  @sh "FIVE_H_RESET=\(.rate_limits.five_hour.resets_at // empty)",
  @sh "SEVEN_D_PCT=\(.rate_limits.seven_day.used_percentage // empty)",
  @sh "SEVEN_D_RESET=\(.rate_limits.seven_day.resets_at // empty)"
' 2>/dev/null)"
DIR_NAME="${DIR##*/}"

# Work hours config (env override, default 9-22)
WORK_START=${STATUSLINE_WORK_START:-9}
WORK_END=${STATUSLINE_WORK_END:-22}
WORK_HOURS=$((WORK_END - WORK_START))

# Integer guards
PCT=${PCT:-0}; CTX_SIZE=${CTX_SIZE:-200000}
INPUT_TOKENS=${INPUT_TOKENS:-0}; OUTPUT_TOKENS=${OUTPUT_TOKENS:-0}
CUR_INPUT=${CUR_INPUT:-0}; CUR_CACHE_CREATE=${CUR_CACHE_CREATE:-0}; CUR_CACHE_READ=${CUR_CACHE_READ:-0}
COST=${COST:-0}; DURATION_MS=${DURATION_MS:-0}; API_DURATION_MS=${API_DURATION_MS:-0}

# Format token counts
fmt_tokens() {
    local n=$1
    if [ "$n" -lt 1000 ]; then
        echo "$n"
    else
        echo "$(( (n + 500) / 1000 ))k"
    fi
}

SEND_FMT=$(fmt_tokens "$INPUT_TOKENS")
RECV_FMT=$(fmt_tokens "$OUTPUT_TOKENS")

# Context used/total
USED=$(( PCT * CTX_SIZE / 100 ))
USED_FMT=$(fmt_tokens "$USED")
CTX_FMT=$(fmt_tokens "$CTX_SIZE")

# Bar color for percentage
bar_color() {
    local pct=$1
    if [ "$pct" -ge 90 ]; then echo "$RED"
    elif [ "$pct" -ge 75 ]; then echo "$ORANGE"
    elif [ "$pct" -ge 50 ]; then echo "$YELLOW"
    else echo "$GREEN"; fi
}

# Progress bar generator: make_bar <pct> <width> [color_override]
make_bar() {
    local pct=$1 width=$2 color_override=$3
    local filled=$((pct * width / 100))
    local empty=$((width - filled))
    local color=${color_override:-$(bar_color "$pct")}
    local fill_str="" empty_str=""
    [ "$filled" -gt 0 ] && fill_str=$(printf "%${filled}s" | tr ' ' '█')
    [ "$empty" -gt 0 ] && empty_str=$(printf "%${empty}s" | tr ' ' '░')
    echo "${color}${fill_str}${DIM}${empty_str}${RESET}"
}

# Rate limit bar color based on usage vs time
rate_bar_color() {
    local usage_pct=$1 time_pct=$2
    if [ "$usage_pct" -ge 90 ]; then echo "$RED"
    elif [ "$time_pct" -le 0 ] || [ "$usage_pct" -le "$time_pct" ]; then echo "$GREEN"
    elif [ "$usage_pct" -lt 50 ] || [ "$usage_pct" -le $((time_pct * 3 / 2)) ]; then echo "$YELLOW"
    else echo "$ORANGE"; fi
}

# Rate limit bar with time marker:
#   make_rate_bar <usage_pct> <time_pct> <width> [color_override] [overlay_pos overlay_color]
# Shows usage fill + │ marker at time position to visualize pace. The optional
# overlay puts a ┃ in overlay_color at cell overlay_pos (used for Fable on the
# 7d bar); on collision with the time marker the ┃ wins.
make_rate_bar() {
    local usage_pct=$1 time_pct=$2 width=$3 color_override=$4
    local overlay_pos=${5:--1} overlay_color=$6
    local usage_pos=$((usage_pct * width / 100))
    local time_pos=$((time_pct * width / 100))
    # Clamp time_pos
    [ "$time_pos" -lt 0 ] && time_pos=0
    [ "$time_pos" -ge "$width" ] && time_pos=$((width - 1))
    local color=${color_override:-$(rate_bar_color "$usage_pct" "$time_pct")}
    # Construct before/after directly by counting characters. Do not use
    # ${var:offset:length}: bash 3.2 (macOS /bin/bash) slices by bytes, and
    # our fill chars (█ U+2588, ░ U+2591) are 3 bytes each in UTF-8 — cutting
    # mid-codepoint leaves orphan bytes that the terminal drops, shifting the
    # bar by one column. See issue #1.
    local before="" after="" i
    local overlay="${RESET}${overlay_color}┃${RESET}${color}"
    for (( i = 0; i < time_pos; i++ )); do
        if [ "$i" -eq "$overlay_pos" ]; then before+="$overlay"
        elif [ "$i" -lt "$usage_pos" ]; then before+="█"; else before+="░"; fi
    done
    local marker="${DIM}│${RESET}"
    [ "$time_pos" -eq "$overlay_pos" ] && marker="${overlay_color}┃${RESET}"
    for (( i = time_pos + 1; i < width; i++ )); do
        if [ "$i" -eq "$overlay_pos" ]; then after+="$overlay"
        elif [ "$i" -lt "$usage_pos" ]; then after+="█"; else after+="░"; fi
    done
    echo "${color}${before}${RESET}${marker}${color}${after}${RESET}"
}

# Compact duration formatter (minute precision, two tiers):
#   >=24h → XdYh   (e.g. 1d10h)
#    <24h → XhYm   (e.g. 4h10m, 0h5m)
fmt_duration_compact() {
    local sec=$1
    [ "$sec" -lt 0 ] && sec=0
    local days=$((sec / 86400))
    if [ "$days" -ge 1 ]; then
        local hours=$(( (sec % 86400) / 3600 ))
        echo "${days}d${hours}h"
    else
        local hours=$((sec / 3600))
        local mins=$(( (sec % 3600) / 60 ))
        echo "${hours}h${mins}m"
    fi
}

# Epoch → "time remaining" (thin wrapper, bails on empty input).
fmt_remaining() {
    local epoch=$1
    [ -z "$epoch" ] && return
    fmt_duration_compact $(( epoch - $(date +%s) ))
}

# Work hour detection
NOW=$(date +%s)
HOUR=$(date +%-H)
IS_WORK_HOUR=true
if [ "$HOUR" -lt "$WORK_START" ] || [ "$HOUR" -ge "$WORK_END" ]; then
    IS_WORK_HOUR=false
fi

# Calculate active time percentage for 7d window
# Counts overlap of each day's work hours [WORK_START, WORK_END] with a time range
calc_active_pct() {
    local ws=$1 we=$2 now=$3
    local active_elapsed=0 total_active=0
    # Get first and last day epochs (midnight)
    local day_epoch
    day_epoch=$(date -r "$ws" +%Y-%m-%d)
    local cursor
    cursor=$(date -j -f "%Y-%m-%d %H:%M:%S" "${day_epoch} 00:00:00" +%s 2>/dev/null)
    local end_date
    end_date=$(date -r "$we" +%Y-%m-%d)
    local end_midnight
    end_midnight=$(date -j -f "%Y-%m-%d %H:%M:%S" "${end_date} 00:00:00" +%s 2>/dev/null)

    while [ "$cursor" -le "$end_midnight" ]; do
        local d_str
        d_str=$(date -r "$cursor" +%Y-%m-%d)
        local a_start a_end
        a_start=$(date -j -f "%Y-%m-%d %H:%M:%S" "${d_str} $(printf '%02d' $WORK_START):00:00" +%s 2>/dev/null)
        a_end=$(date -j -f "%Y-%m-%d %H:%M:%S" "${d_str} $(printf '%02d' $WORK_END):00:00" +%s 2>/dev/null)

        # Elapsed active: overlap of [a_start,a_end] with [ws,now]
        local e_s e_e
        e_s=$((a_start > ws ? a_start : ws))
        e_e=$((a_end < now ? a_end : now))
        [ "$e_e" -gt "$e_s" ] && active_elapsed=$((active_elapsed + e_e - e_s))

        # Total active: overlap of [a_start,a_end] with [ws,we]
        local t_s t_e
        t_s=$((a_start > ws ? a_start : ws))
        t_e=$((a_end < we ? a_end : we))
        [ "$t_e" -gt "$t_s" ] && total_active=$((total_active + t_e - t_s))

        cursor=$((cursor + 86400))
    done

    if [ "$total_active" -gt 0 ]; then
        echo $((active_elapsed * 100 / total_active))
    else
        echo 0
    fi
}

# Context window bar
BAR=$(make_bar "$PCT" 20)
BAR_COLOR=$(bar_color "$PCT")

WALL_FMT=$(fmt_duration_compact $((DURATION_MS / 1000)))
API_FMT=$(fmt_duration_compact $((API_DURATION_MS / 1000)))

# Cost
COST_FMT=$(printf '$%.2f' "$COST")

# Month-to-date cost (ccusage-backed). Cached in ~/.claude/ccusage-cache.json
# with a TTL, refreshed lazily in the background so rendering stays fast.
# Session cost above is live from stdin; monthly needs to scan JSONL so we cache.
CCUSAGE_CACHE="$HOME/.claude/ccusage-cache.json"
CCUSAGE_TTL=${STATUSLINE_CCUSAGE_TTL:-600}  # seconds; override with env if desired

TODAY_COST=""
MONTH_COST=""
CACHE_AGE=99999
if [ -f "$CCUSAGE_CACHE" ]; then
    CACHE_AGE=$(( NOW - $(stat -f %m "$CCUSAGE_CACHE") ))
    TODAY_COST=$(jq -r '.today // ""' "$CCUSAGE_CACHE" 2>/dev/null)
    MONTH_COST=$(jq -r '.month // ""' "$CCUSAGE_CACHE" 2>/dev/null)
fi

# Compact cost formatter: $X.XX / $XX.X / $XXX / $X.XK
fmt_cost_compact() {
    local c=$1
    [ -z "$c" ] && { echo "--"; return; }
    awk -v c="$c" 'BEGIN {
        if (c+0 < 10) printf "$%.2f", c
        else if (c+0 < 100) printf "$%.1f", c
        else if (c+0 < 1000) printf "$%.0f", c
        else if (c+0 < 10000) printf "$%.1fK", c/1000
        else printf "$%.0fK", c/1000
    }'
}
TODAY_FMT=$(fmt_cost_compact "$TODAY_COST")
MONTH_FMT=$(fmt_cost_compact "$MONTH_COST")

# Fable weekly usage, overlaid on the 7d bar. CC's statusline stdin doesn't
# carry it (rate_limits projects only five_hour/seven_day/spend_limit, checked
# through CC 2.1.280), so we read the same endpoint /usage does and cache it
# the way the ccusage block above does: rendering only reads the cache, and a
# cache past its TTL forks one background refresher (mkdir lock).
USAGE_CACHE="$HOME/.claude/statusline-usage-cache.json"
USAGE_TTL=${STATUSLINE_USAGE_TTL:-300}  # seconds between refresh attempts
USAGE_STALE=3600                         # data older than this renders DIM

FABLE_PCT=""; FABLE_FETCHED_AT=0; USAGE_ATTEMPTED_AT=0
if [ -f "$USAGE_CACHE" ]; then
    eval "$(jq -r '
      @sh "FABLE_PCT=\(.fable.pct // "")",
      @sh "FABLE_FETCHED_AT=\(.fetched_at // 0)",
      @sh "USAGE_ATTEMPTED_AT=\(.attempted_at // 0)"
    ' "$USAGE_CACHE" 2>/dev/null)"
fi

# Either cache stale → refresh in the background and keep rendering with the
# current (possibly stale) values. The refresher lives in its own script,
# shared with the desktop statusband mod; it re-checks each TTL (attempted_at
# for usage, so failures back off) and takes an mkdir lock per cache.
REFRESH_SCRIPT="${BASH_SOURCE[0]%/*}/statusline-refresh-caches.sh"
if { [ "$CACHE_AGE" -gt "$CCUSAGE_TTL" ] || [ $(( NOW - USAGE_ATTEMPTED_AT )) -gt "$USAGE_TTL" ]; } \
    && [ -f "$REFRESH_SCRIPT" ]; then
    bash "$REFRESH_SCRIPT" </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
fi

# Cache hit rate (last API call). Inverse color — higher is better.
# current_usage is null before first API call; denom will be 0 → show "--".
CACHE_DENOM=$((CUR_INPUT + CUR_CACHE_CREATE + CUR_CACHE_READ))
if [ "$CACHE_DENOM" -gt 0 ]; then
    CACHE_HIT_PCT=$((CUR_CACHE_READ * 100 / CACHE_DENOM))
    if [ "$CACHE_HIT_PCT" -ge 95 ]; then CACHE_COLOR="$GREEN"
    elif [ "$CACHE_HIT_PCT" -ge 80 ]; then CACHE_COLOR="$YELLOW"
    elif [ "$CACHE_HIT_PCT" -ge 50 ]; then CACHE_COLOR="$ORANGE"
    else CACHE_COLOR="$RED"; fi
    CACHE_FMT="💾 ${CACHE_COLOR}${CACHE_HIT_PCT}%${RESET}"
else
    CACHE_FMT="${DIM}💾 --${RESET}"
fi

# Prompt-cache expiry: when the last main-thread request's cache dies, so you
# can tell before /model or /compact whether you're about to throw away a warm
# cache (think twice) or a cold one (free). Source is the transcript, not the
# Stop hook — Stop can skip on Esc interrupts; the assistant entry can't.
#   ⏳HH:MM  green: warm until HH:MM (rebuild size = the context-used figure
#            on line 2, which is the same input+cache_read+cache_creation sum)
#   ❄cold    dim:   already expired at render time
# Shown as an absolute time for the same reason as ⏱ below (renders freeze
# while idle; Ctrl+C forces a fresh one). A frozen view can only claim
# "warm" when it's actually cold — never the reverse, since re-warming takes a
# request, which re-renders — so staleness errs on the safe side. Every other
# uncertainty is biased the same way: TTL is 5m only when the write was
# purely 5m (else 1h), and the entry timestamp is response-end, later than
# the request that refreshed the TTL. The idle "recap" (system/away_summary,
# fired ~10min into idle) is a model call over the same prefix and renews the
# TTL too — observed: 67min gap still hit 99% because a recap landed at +10min
# — so the anchor is the later of the last assistant entry and the last recap.
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    read -r CACHE_REQ_AT CACHE_TTL < <(tail -n 300 "$TRANSCRIPT" | jq -nrR '
        [inputs | fromjson? | select(.isSidechain | not)] as $e
        | ($e | map(select(.type == "assistant" and .message.model != "<synthetic>"
            and .message.usage != null)) | last) // empty
        | .message.usage as $u
        | ($u.cache_creation.ephemeral_1h_input_tokens // 0) as $h1
        | ($u.cache_creation.ephemeral_5m_input_tokens // 0) as $m5
        | [ ([., ($e | map(select(.type == "system" and .subtype == "away_summary")) | last)]
              | map(select(. != null) | .timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)
              | max),
            (if $m5 > 0 and $h1 == 0 then 300 else 3600 end) ]
        | @tsv' 2>/dev/null)
    if [ -n "$CACHE_REQ_AT" ] && [ -n "$CACHE_TTL" ]; then
        CACHE_EXPIRES=$((CACHE_REQ_AT + CACHE_TTL))
        if [ "$NOW" -lt "$CACHE_EXPIRES" ]; then
            CACHE_FMT="${CACHE_FMT} ${GREEN}⏳$(date -r "$CACHE_EXPIRES" +%H:%M)${RESET}"
        else
            CACHE_FMT="${CACHE_FMT} ${DIM}❄cold${RESET}"
        fi
    fi
fi

# Rate limits
if [ -n "$FIVE_H_PCT" ]; then
    FIVE_H_PCT_INT=$(printf '%.0f' "$FIVE_H_PCT")
    FIVE_H_REMAINING=$(fmt_remaining "$FIVE_H_RESET")
    if [ -n "$FIVE_H_RESET" ]; then
        FIVE_H_TIME_PCT=$(( (18000 - (FIVE_H_RESET - NOW)) * 100 / 18000 ))
        [ "$FIVE_H_TIME_PCT" -lt 0 ] && FIVE_H_TIME_PCT=0
        [ "$FIVE_H_TIME_PCT" -gt 100 ] && FIVE_H_TIME_PCT=100
        FIVE_H_BAR=$(make_rate_bar "$FIVE_H_PCT_INT" "$FIVE_H_TIME_PCT" 10)
        FIVE_H_COLOR=$(rate_bar_color "$FIVE_H_PCT_INT" "$FIVE_H_TIME_PCT")
    else
        FIVE_H_BAR=$(make_bar "$FIVE_H_PCT_INT" 10)
        FIVE_H_COLOR=$(bar_color "$FIVE_H_PCT_INT")
    fi
    # Non-work-hour: force red for bar and percentage
    if [ "$IS_WORK_HOUR" = false ]; then
        FIVE_H_BAR=$(make_rate_bar "$FIVE_H_PCT_INT" "$FIVE_H_TIME_PCT" 10 "$RED")
        FIVE_H_COLOR="$RED"
    fi
    FIVE_H_FMT="5h ${FIVE_H_BAR} ${FIVE_H_COLOR}${FIVE_H_PCT_INT}%${RESET}"
    [ -n "$FIVE_H_REMAINING" ] && FIVE_H_FMT="${FIVE_H_FMT} ${DIM}(${FIVE_H_REMAINING})${RESET}"
else
    FIVE_H_FMT="${DIM}5h --${RESET}"
fi

SEVEN_D_WIDTH=14
if [ -n "$SEVEN_D_PCT" ]; then
    SEVEN_D_PCT_INT=$(printf '%.0f' "$SEVEN_D_PCT")
    SEVEN_D_REMAINING=$(fmt_remaining "$SEVEN_D_RESET")
    if [ -n "$SEVEN_D_RESET" ]; then
        # Use active hours only for 7d time progress
        SEVEN_D_TIME_PCT=$(calc_active_pct "$((SEVEN_D_RESET - 604800))" "$SEVEN_D_RESET" "$NOW")
        [ "$SEVEN_D_TIME_PCT" -lt 0 ] && SEVEN_D_TIME_PCT=0
        [ "$SEVEN_D_TIME_PCT" -gt 100 ] && SEVEN_D_TIME_PCT=100
    fi
    # Fable overlay: ┃ at its percentage on this bar + "fbNN%" after ours.
    # Fable's weekly window shares 7d's resets_at, so its pace color uses the
    # same time progress. Stale data goes DIM, which beats the off-hours red.
    FABLE_POS=-1; FABLE_COLOR=""; FABLE_FMT="${DIM}fb--${RESET}"
    if [ -n "$FABLE_PCT" ]; then
        FABLE_PCT_INT=$(printf '%.0f' "$FABLE_PCT")
        FABLE_POS=$((FABLE_PCT_INT * SEVEN_D_WIDTH / 100))
        [ "$FABLE_POS" -ge "$SEVEN_D_WIDTH" ] && FABLE_POS=$((SEVEN_D_WIDTH - 1))
        if [ $(( NOW - FABLE_FETCHED_AT )) -gt "$USAGE_STALE" ]; then FABLE_COLOR="$DIM"
        elif [ "$IS_WORK_HOUR" = false ]; then FABLE_COLOR="$RED"
        elif [ -n "$SEVEN_D_RESET" ]; then FABLE_COLOR=$(rate_bar_color "$FABLE_PCT_INT" "$SEVEN_D_TIME_PCT")
        else FABLE_COLOR=$(bar_color "$FABLE_PCT_INT"); fi
        FABLE_FMT="${FABLE_COLOR}fb${FABLE_PCT_INT}%${RESET}"
    fi
    if [ -n "$SEVEN_D_RESET" ]; then
        SEVEN_D_BAR=$(make_rate_bar "$SEVEN_D_PCT_INT" "$SEVEN_D_TIME_PCT" "$SEVEN_D_WIDTH" "" "$FABLE_POS" "$FABLE_COLOR")
        SEVEN_D_COLOR=$(rate_bar_color "$SEVEN_D_PCT_INT" "$SEVEN_D_TIME_PCT")
    else
        SEVEN_D_BAR=$(make_bar "$SEVEN_D_PCT_INT" "$SEVEN_D_WIDTH")
        SEVEN_D_COLOR=$(bar_color "$SEVEN_D_PCT_INT")
    fi
    # Non-work-hour: force red for bar and percentage
    if [ "$IS_WORK_HOUR" = false ]; then
        SEVEN_D_BAR=$(make_rate_bar "$SEVEN_D_PCT_INT" "$SEVEN_D_TIME_PCT" "$SEVEN_D_WIDTH" "$RED" "$FABLE_POS" "$FABLE_COLOR")
        SEVEN_D_COLOR="$RED"
    fi
    SEVEN_D_FMT="7d ${SEVEN_D_BAR} ${SEVEN_D_COLOR}${SEVEN_D_PCT_INT}%${RESET} ${FABLE_FMT}"
    [ -n "$SEVEN_D_REMAINING" ] && SEVEN_D_FMT="${SEVEN_D_FMT} ${DIM}(${SEVEN_D_REMAINING})${RESET}"
else
    SEVEN_D_FMT="${DIM}7d --${RESET}"
fi

# Git branch & diff stats (cached by session_id, TTL 5s)
BRANCH=""
SHORTSTAT=""
GIT_CACHE="/tmp/statusline-git-${SESSION_ID}"
CACHE_HIT=false

if [ -n "$SESSION_ID" ] && [ -f "$GIT_CACHE" ]; then
    CACHE_AGE=$(( NOW - $(stat -f %m "$GIT_CACHE") ))
    [ "$CACHE_AGE" -lt 5 ] && CACHE_HIT=true
fi

if [ "$CACHE_HIT" = true ]; then
    BRANCH=$(sed -n '1p' "$GIT_CACHE")
    SHORTSTAT=$(sed -n '2p' "$GIT_CACHE")
else
    if git rev-parse --git-dir > /dev/null 2>&1; then
        BRANCH=$(git branch --show-current 2>/dev/null)
        SHORTSTAT=$(git diff --shortstat HEAD 2>/dev/null)
        if [ -n "$SESSION_ID" ]; then
            printf '%s\n%s\n' "$BRANCH" "$SHORTSTAT" > "$GIT_CACHE"
        fi
    fi
fi

FILE_COUNT=$(echo "$SHORTSTAT" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+')
DIFF_ADD=$(echo "$SHORTSTAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+')
DIFF_DEL=$(echo "$SHORTSTAT" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+')
FILE_COUNT=${FILE_COUNT:-0}; DIFF_ADD=${DIFF_ADD:-0}; DIFF_DEL=${DIFF_DEL:-0}

# Last-reply timestamp (written by hooks/last-reply.sh on every Stop event).
# Rendered unconditionally as plain "⏱ MM-DD.HH:MM" — absolute stamp, no
# delta, no threshold. Every delta-based rule we tried (Xh-ago, just-now, same-day
# vs cross-day, hide-past-24h) turned out to be the same trap: the
# statusline only re-renders on interaction, and re-renders within seconds
# of the reply, so any check on NOW - LAST_REPLY_AT is computed while the
# reply is essentially "just now" — it always agrees with whatever fresh
# branch, then freezes that decision for the entire idle window. The one
# number that stays truthful as the view ages is the reply's own
# wall-clock time; the user glances at it against their watch. Missing
# file (first turn, or hook not installed) → segment is suppressed.
LAST_REPLY_FMT=""
if [ -n "$SESSION_ID" ]; then
    LAST_REPLY_FILE="$HOME/.claude/session-meta/${SESSION_ID}/last-reply.json"
    if [ -f "$LAST_REPLY_FILE" ]; then
        LAST_REPLY_AT=$(jq -r '.at // empty' "$LAST_REPLY_FILE" 2>/dev/null)
        if [ -n "$LAST_REPLY_AT" ]; then
            LAST_REPLY_FMT="⏱ $(date -r "$LAST_REPLY_AT" +%m-%d.%H:%M 2>/dev/null)"
        fi
    fi
fi

# OSC 8 hyperlink: cmd/modifier+click in supporting terminals (iTerm2, Ghostty,
# WezTerm, Kitty, ...) opens DIR in Finder via the file:// URL. Terminals that
# don't understand OSC 8 (Terminal.app) silently ignore it.
# Use BEL (\a) as the OSC terminator — widely accepted and safe with `echo -e`,
# which would otherwise interpret `\033\\<text>` containing a "\c" stop-output
# sequence and truncate the rest of the status line.
# URL-encode spaces; other special chars in paths are rare enough to skip.
DIR_URL="file://${DIR// /%20}"
DIR_LINK="\033]8;;${DIR_URL}\a${DIR_NAME}\033]8;;\a"

# Build two lines
# A newer CC version may be installed on disk while this session keeps running
# the version it started with. Probe common install layouts to find what's on
# disk; if it's strictly newer than CC_VERSION, append a yellow ↑ as a hint
# to restart. Layouts covered:
#   - native installer: ~/.local/share/claude/versions/<X.Y.Z>  (multi-version dir)
#   - npm/bun/brew:     <prefix>/node_modules/@anthropic-ai/claude-code/package.json
cc_latest_installed() {
    local native_dir="$HOME/.local/share/claude/versions"
    if [ -d "$native_dir" ]; then
        ls -1 "$native_dir" 2>/dev/null \
            | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
            | sort -V | tail -1
        return
    fi
    local p
    for p in \
        "$HOME/.claude/local/node_modules/@anthropic-ai/claude-code/package.json" \
        "$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json" \
        "$HOME/.bun/install/global/node_modules/@anthropic-ai/claude-code/package.json" \
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/package.json" \
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json"; do
        if [ -f "$p" ]; then
            jq -r '.version // empty' "$p" 2>/dev/null
            return
        fi
    done
}

VERSION_STR=""
if [ -n "$CC_VERSION" ]; then
    VERSION_STR=" v${CC_VERSION}"
    CC_LATEST=$(cc_latest_installed)
    if [ -n "$CC_LATEST" ] && [ "$CC_LATEST" != "$CC_VERSION" ]; then
        # sort -V puts oldest first; confirm $CC_LATEST is strictly newer
        # (guards against a stray older entry on disk).
        newer=$(printf '%s\n%s\n' "$CC_VERSION" "$CC_LATEST" | sort -V | tail -1)
        [ "$newer" = "$CC_LATEST" ] && VERSION_STR="${VERSION_STR}${YELLOW}↑${CYAN}"
    fi
fi

LINE1="${CYAN}[${MODEL}${VERSION_STR}]${RESET} 📁 ${DIR_LINK}"
[ -n "$BRANCH" ] && LINE1="${LINE1} ${DIM}|${RESET} 🔀 ${GREEN}${BRANCH}${RESET}"
LINE1="${LINE1} ${DIM}|${RESET} ${FILE_COUNT} files ${GREEN}+${DIFF_ADD}${RESET} ${RED}-${DIFF_DEL}${RESET}"
# Uncomment to show cumulative session tokens (↑input ↓output):
# LINE1="${LINE1} ${DIM}|${RESET} ${DIM}↑${SEND_FMT} ↓${RECV_FMT}${RESET}"
LINE1="${LINE1} ${DIM}|${RESET} ${CACHE_FMT}"
LINE1="${LINE1} ${DIM}|${RESET} ${YELLOW}${COST_FMT}${RESET}${DIM}/${RESET}${DIM}${TODAY_FMT}${RESET}${DIM}/${RESET}${DIM}${MONTH_FMT}${RESET}"

LINE2="${BAR} ${BAR_COLOR}${PCT}%${RESET} ${DIM}(${USED_FMT}/${CTX_FMT})${RESET}"
LINE2="${LINE2} ${DIM}|${RESET} ${FIVE_H_FMT}"
LINE2="${LINE2} ${DIM}|${RESET} ${SEVEN_D_FMT}"
LINE2="${LINE2} ${DIM}|${RESET} ${API_FMT} ${DIM}/${RESET} ${WALL_FMT}"
[ -n "$LAST_REPLY_FMT" ] && LINE2="${LINE2} ${DIM}|${RESET} ${LAST_REPLY_FMT}"

echo -e "${LINE1}\n${LINE2}"
