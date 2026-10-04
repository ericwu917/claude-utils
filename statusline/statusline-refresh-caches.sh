#!/bin/bash
# Refresh the statusline's slow data caches. Shared by statusline.sh (CLI) and
# the statusband mod (desktop app); both only ever read the cache files.
#
#   statusline-refresh-caches.sh [ccusage|usage]...   (no args: both)
#
# Each cache is refreshed only when past its TTL, under an mkdir lock so
# concurrent callers don't pile up refreshers. Runs in the foreground: a caller
# that must not block (statusline rendering) backgrounds it itself.
#
#   ~/.claude/ccusage-cache.json            {today, month, updated_at}
#   ~/.claude/statusline-usage-cache.json   {fable, fetched_at, attempted_at, source}

NOW=$(date +%s)

# Drop a lock left by a dead refresher (older than 60s).
clear_stale_lock() {
    [ -d "$1" ] && [ $(( NOW - $(stat -f %m "$1") )) -gt 60 ] && rmdir "$1" 2>/dev/null
    return 0
}

# Today's and month-to-date cost, from ccusage (scans the JSONL, hence cached).
refresh_ccusage() (
    CACHE="$HOME/.claude/ccusage-cache.json"
    LOCK="$HOME/.claude/ccusage-cache.lock"
    TTL=${STATUSLINE_CCUSAGE_TTL:-600}

    [ -f "$CACHE" ] && [ $(( NOW - $(stat -f %m "$CACHE") )) -le "$TTL" ] && exit 0
    BIN=$(command -v ccusage 2>/dev/null)
    [ -z "$BIN" ] && [ -x "$HOME/.bun/bin/ccusage" ] && BIN="$HOME/.bun/bin/ccusage"
    [ -n "$BIN" ] || exit 0
    clear_stale_lock "$LOCK"
    mkdir "$LOCK" 2>/dev/null || exit 0
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT

    TZ_NAME=${STATUSLINE_CCUSAGE_TZ:-$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')}
    TZ_NAME=${TZ_NAME:-UTC}
    # Month-start in the reporting TZ (not the system TZ) so the month
    # boundary lines up with what ccusage --timezone buckets by.
    MONTH_START=$(TZ="$TZ_NAME" date +%Y%m01)
    TODAY_DATE=$(TZ="$TZ_NAME" date +%Y-%m-%d)
    DATA=$("$BIN" daily --since "$MONTH_START" --timezone "$TZ_NAME" --json 2>/dev/null)
    [ -n "$DATA" ] || exit 0
    # Single ccusage call — month = sum over all days, today = filter
    # to today's date. Free lunch; same source JSON.
    M=$(echo "$DATA" | jq -r '[.daily[].totalCost] | (add // 0)')
    T=$(echo "$DATA" | jq -r --arg d "$TODAY_DATE" '[.daily[] | select(.date==$d) | .totalCost] | (add // 0)')
    if [ -n "$M" ] && [ -n "$T" ]; then
        # mktemp alongside the cache file guarantees same filesystem,
        # so the mv below is an atomic rename (no half-written state).
        tmp=$(mktemp "${CACHE}.XXXXXX")
        jq -n --argjson t "$T" --argjson m "$M" --arg u "$(date +%s)" \
            '{today: $t, month: $m, updated_at: ($u | tonumber)}' > "$tmp" && \
            mv "$tmp" "$CACHE"
    fi
)

# Fable weekly usage. CC's statusline stdin doesn't carry it (rate_limits
# projects only five_hour/seven_day/spend_limit, checked through CC 2.1.280),
# so we read the same endpoint /usage does.
refresh_usage() (
    CACHE="$HOME/.claude/statusline-usage-cache.json"
    LOCK="$HOME/.claude/statusline-usage-cache.lock"
    TTL=${STATUSLINE_USAGE_TTL:-300}  # seconds between refresh attempts

    FABLE_FETCHED_AT=0; ATTEMPTED_AT=0
    if [ -f "$CACHE" ]; then
        eval "$(jq -r '
          @sh "FABLE_FETCHED_AT=\(.fetched_at // 0)",
          @sh "ATTEMPTED_AT=\(.attempted_at // 0)"
        ' "$CACHE" 2>/dev/null)"
    fi
    # Gate on attempted_at, not fetched_at: a failed refresh (401/429/offline)
    # still bumps it, so failures back off one TTL instead of retrying every call.
    [ $(( NOW - ATTEMPTED_AT )) -gt "$TTL" ] || exit 0
    clear_stale_lock "$LOCK"
    mkdir "$LOCK" 2>/dev/null || exit 0
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
    exec </dev/null

    # Undocumented endpoint, so the shape is as observed: a limits[] entry
    # with kind "weekly_scoped" and scope.model.display_name "Fable";
    # percent is already 0-100; resets_at looks like
    # 2026-09-30T04:00:00.373624+00:00, which fromdateiso8601 only takes
    # after dropping the fraction and spelling UTC as Z.
    FABLE_DEF='def fable: [.limits[]? | select(.kind == "weekly_scoped"
                 and ((.scope.model.display_name // "") | ascii_downcase | startswith("fable")))][0]
               | if . == null then null else
                   {pct: .percent,
                    resets_at: (.resets_at | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z")
                                | try fromdateiso8601 catch null)} end;'
    FABLE="" FETCHED="" SOURCE=""

    # 1) The API, only while CC's stored token is still valid. Never
    #    refresh it here: a refresh rotates the refresh token and would
    #    strand CC's own copy. The token reaches curl through stdin
    #    (--config -), so it never shows up in argv / ps.
    TOK=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
        | jq -r --argjson now "$(date +%s)" \
            'select((.claudeAiOauth.expiresAt // 0) / 1000 > $now + 60) | .claudeAiOauth.accessToken // empty' 2>/dev/null)
    if [ -n "$TOK" ]; then
        BODY=$(printf 'url = "https://api.anthropic.com/api/oauth/usage"\nheader = "Authorization: Bearer %s"\nheader = "anthropic-beta: oauth-2025-04-20"\nheader = "User-Agent: claude-utils-statusline"\n' "$TOK" \
            | curl -sf --max-time 5 --config - 2>/dev/null)
        # A 200 without a Fable bucket is still an answer (fable: null);
        # only a failed call falls through to the fallback.
        if printf '%s' "$BODY" | jq -e 'has("limits")' >/dev/null 2>&1; then
            FABLE=$(printf '%s' "$BODY" | jq -c "$FABLE_DEF fable")
            FETCHED=$(date +%s); SOURCE=api
        fi
    fi
    unset TOK BODY

    # 2) Fallback: CC keeps the same response in ~/.claude.json
    #    (cachedUsageUtilization) whenever it fetches it itself, e.g. on
    #    /usage. Take it only if it's this account's and newer than ours.
    if [ -z "$SOURCE" ] && [ -f "$HOME/.claude.json" ]; then
        CC_USAGE=$(jq -c --argjson have "$FABLE_FETCHED_AT" "$FABLE_DEF"'
            .oauthAccount.accountUuid as $acct
            | .cachedUsageUtilization
            | select(. != null and .accountUuid == $acct and (.fetchedAtMs / 1000 | floor) > $have)
            | {fetched_at: (.fetchedAtMs / 1000 | floor), fable: (.utilization | fable)}' "$HOME/.claude.json" 2>/dev/null)
        if [ -n "$CC_USAGE" ]; then
            FABLE=$(printf '%s' "$CC_USAGE" | jq -c '.fable')
            FETCHED=$(printf '%s' "$CC_USAGE" | jq -r '.fetched_at')
            SOURCE=cc_cache
        fi
    fi

    # Atomic write (mktemp next to the cache → same filesystem → rename).
    # No new data: keep what we had, only bump attempted_at.
    tmp=$(mktemp "${CACHE}.XXXXXX") || exit 0
    if [ -n "$SOURCE" ]; then
        jq -n --argjson f "$FABLE" --argjson t "$FETCHED" --argjson a "$(date +%s)" --arg s "$SOURCE" \
            '{fable: $f, fetched_at: $t, attempted_at: $a, source: $s}'
    elif [ -f "$CACHE" ]; then
        jq --argjson a "$(date +%s)" '.attempted_at = $a' "$CACHE"
    else
        jq -n --argjson a "$(date +%s)" '{fable: null, fetched_at: null, attempted_at: $a, source: null}'
    fi > "$tmp" && mv "$tmp" "$CACHE" || rm -f "$tmp"
)

[ $# -eq 0 ] && set -- ccusage usage
for part in "$@"; do
    case $part in
        ccusage) refresh_ccusage ;;
        usage)   refresh_usage ;;
        *)       echo "unknown cache: $part (ccusage|usage)" >&2; exit 2 ;;
    esac
done
exit 0
