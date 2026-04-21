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

# Usable context ratio (80% of total is practical limit)
USABLE_RATIO=80
USABLE_PCT=$(( PCT * 100 / USABLE_RATIO ))
[ "$USABLE_PCT" -gt 100 ] && USABLE_PCT=100

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

# Rate limit bar with time marker: make_rate_bar <usage_pct> <time_pct> <width> [color_override]
# Shows usage fill + │ marker at time position to visualize pace
make_rate_bar() {
    local usage_pct=$1 time_pct=$2 width=$3 color_override=$4
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
    for (( i = 0; i < time_pos; i++ )); do
        if [ "$i" -lt "$usage_pos" ]; then before+="█"; else before+="░"; fi
    done
    for (( i = time_pos + 1; i < width; i++ )); do
        if [ "$i" -lt "$usage_pos" ]; then after+="█"; else after+="░"; fi
    done
    echo "${color}${before}${RESET}${DIM}│${RESET}${color}${after}${RESET}"
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

if [ -n "$SEVEN_D_PCT" ]; then
    SEVEN_D_PCT_INT=$(printf '%.0f' "$SEVEN_D_PCT")
    SEVEN_D_REMAINING=$(fmt_remaining "$SEVEN_D_RESET")
    if [ -n "$SEVEN_D_RESET" ]; then
        # Use active hours only for 7d time progress
        SEVEN_D_TIME_PCT=$(calc_active_pct "$((SEVEN_D_RESET - 604800))" "$SEVEN_D_RESET" "$NOW")
        [ "$SEVEN_D_TIME_PCT" -lt 0 ] && SEVEN_D_TIME_PCT=0
        [ "$SEVEN_D_TIME_PCT" -gt 100 ] && SEVEN_D_TIME_PCT=100
        SEVEN_D_BAR=$(make_rate_bar "$SEVEN_D_PCT_INT" "$SEVEN_D_TIME_PCT" 14)
        SEVEN_D_COLOR=$(rate_bar_color "$SEVEN_D_PCT_INT" "$SEVEN_D_TIME_PCT")
    else
        SEVEN_D_BAR=$(make_bar "$SEVEN_D_PCT_INT" 14)
        SEVEN_D_COLOR=$(bar_color "$SEVEN_D_PCT_INT")
    fi
    # Non-work-hour: force red for bar and percentage
    if [ "$IS_WORK_HOUR" = false ]; then
        SEVEN_D_BAR=$(make_rate_bar "$SEVEN_D_PCT_INT" "$SEVEN_D_TIME_PCT" 14 "$RED")
        SEVEN_D_COLOR="$RED"
    fi
    SEVEN_D_FMT="7d ${SEVEN_D_BAR} ${SEVEN_D_COLOR}${SEVEN_D_PCT_INT}%${RESET}"
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
LINE1="${CYAN}[${MODEL}]${RESET} 📁 ${DIR_LINK}"
[ -n "$BRANCH" ] && LINE1="${LINE1} ${DIM}|${RESET} 🔀 ${GREEN}${BRANCH}${RESET}"
LINE1="${LINE1} ${DIM}|${RESET} ${FILE_COUNT} files ${GREEN}+${DIFF_ADD}${RESET} ${RED}-${DIFF_DEL}${RESET}"
# Uncomment to show cumulative session tokens (↑input ↓output):
# LINE1="${LINE1} ${DIM}|${RESET} ${DIM}↑${SEND_FMT} ↓${RECV_FMT}${RESET}"
LINE1="${LINE1} ${DIM}|${RESET} ${CACHE_FMT}"
LINE1="${LINE1} ${DIM}|${RESET} ${YELLOW}${COST_FMT}${RESET} ${DIM}/${RESET} ${API_FMT} ${DIM}/${RESET} ${WALL_FMT}"

USABLE_COLOR=$(bar_color "$USABLE_PCT")
LINE2="${BAR} ${BAR_COLOR}${PCT}%${RESET} ${USABLE_COLOR}[${USABLE_PCT}%]${RESET} ${DIM}(${USED_FMT}/${CTX_FMT})${RESET}"
LINE2="${LINE2} ${DIM}|${RESET} ${FIVE_H_FMT}"
LINE2="${LINE2} ${DIM}|${RESET} ${SEVEN_D_FMT}"
# (Session wall + API durations now shown inline with cost on line 1 as
#  `$X.XX / api / wall`. If you ever want them on line 2 instead, reference
#  $WALL_FMT / $API_FMT here.)

echo -e "${LINE1}\n${LINE2}"
