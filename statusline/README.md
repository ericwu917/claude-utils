# Custom Claude Code statusline

A dual-line terminal statusline for Claude Code. Real-time view of your work environment and session state.

> **Retired — kept as a fallback.** The [statusband mod](../mods/statusband/) now draws these two lines as a band above the prompt, in both the CLI and the desktop app, from each session's own account. `install.sh` no longer installs this script by default; `install.sh --statusline` still does, for setups without mods.

[中文版](README.zh.md)

## Preview

<p align="center">
  <img src="../docs/images/statusline.png" alt="dual-line statusline preview — line 1 model, directory, branch + diff, token throughput, cost; line 2 context window + 5h/7d rate-limit bars with time markers" width="820" />
</p>

## Layout

### Line 1 — work environment

| Field | Description |
|------|------|
| `[Opus 4.6 (1M context) v2.1.139↑]` | Current model + Claude Code CLI version. Yellow `↑` flags a newer CC version on disk — see [Upgrade hint](#upgrade-hint). |
| `📁 project` | Project directory name |
| `🔀 master` | Git branch |
| `3 files +25 -10` | Uncommitted file changes (`git diff --shortstat HEAD`) |
| `💾 95%` | Prompt cache hit rate for the **last** API call |
| `⏳12:59` / `❄cold` | Prompt cache expiry (appended to `💾`): warm until `12:59`, or already expired. See [Prompt cache expiry](#prompt-cache-expiry). |
| `$3.42 / $54.3 / $3.2K` | Session cost **/** today's cost **/** month-to-date cost. Session is live from stdin; today & month come from [`ccusage`](https://github.com/ryoppippi/ccusage) (optional — displays `--` if not installed). Compact `$` format: `$X.XX` < 10, `$XX.X` < 100, `$XXX` < 1000, `$X.XK` ≥ 1000. |
| `4h10m / 1d2h` | Cumulative API wait time **/** session wall-clock time. Compact duration format: `<24h` → `XhYm`, `≥24h` → `XdYh` (minute precision; same formatter drives the `5h`/`7d` countdowns). |

### Line 2 — quota status

| Field | Description |
|------|------|
| `████░░░░ 35% (70k/200k)` | Context window usage (20-char bar) |
| `5h ██░│░░░ 27% (3h12m)` | 5-hour rolling-window usage (10-char bar) |
| `7d ████░│░░┃░░░ 30% fb62% (5d8h)` | 7-day window usage (14-char bar), with Fable's weekly usage overlaid as `┃` + `fbNN%` — see [Fable overlay](#fable-overlay) |
| `⏱ 08-07.14:32` | When CC last finished replying in this session (wall-clock `MM-DD.HH:MM`). Populated by the `Stop` hook `hooks/last-reply.sh`; hidden until that hook has fired at least once. |

## Core features

### Rate-limit progress bar with time marker

The 5h and 7d bars overlay a time-progress marker `│` so you can tell at a glance whether your burn rate is sustainable:

```
usage < time progress → green (sustainable)
  5h ██│░░░░░░░ 27%

usage > time progress → yellow/orange (burning too fast)
  5h █████│░░░░ 60%

usage >= 90% → red (high watermark)
  5h █████████│ 95%
```

Color rules:
- **Green** — usage ≤ time progress; sustainable pace
- **Yellow** — usage slightly above time progress, or usage < 50% (low-usage protection against early-window false alarms)
- **Orange** — usage > time progress × 1.5
- **Red** — usage ≥ 90% (absolute high watermark)

### Prompt cache hit rate

`💾 XX%` shows what fraction of the most recent API call's input tokens were served from the prompt cache:

```
hit% = cache_read_input_tokens / (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
```

All three fields live under `context_window.current_usage` (which is `null` before the session's first API call → displayed as `💾 --`).

Because only `current_usage` is exposed (not cumulative cache totals), this reflects **one turn**, not session-wide. A single low-hit turn isn't a problem — watch for several low turns in a row.

Thresholds (calibrated against observed Claude Code steady state, **not an Anthropic-published target** — the docs intentionally avoid prescribing a number):

| Hit% | Color | Reading |
|---|---|---|
| ≥ 95% | 🟢 green | healthy steady state (typical CC long-session value) |
| 80–95% | 🟡 yellow | normal fluctuation — this turn absorbed a big new chunk (file read, large tool output) |
| 50–80% | 🟠 orange | something is systematically evicting the cache |
| < 50% | 🔴 red | first turn / `/clear` just ran / >5min idle / cache genuinely broken |

Things that break the cache mid-session: editing `CLAUDE.md` / `settings.json` / hooks, loading or unloading an MCP server, switching model or permission mode, frequent `/clear`, spawning many sub-agents (each starts cold), leaving the session idle for >5 minutes (Anthropic's default cache TTL).

### Prompt cache expiry

`⏳HH:MM` (green) / `❄cold` (dim), appended to `💾`, answers "is the cache still warm?" **before** you do something cache-busting like `/model` or `/compact`. Warm: switching throws away a cheap cache-read turn and pays a full write of the whole context instead (its size is the context-used figure on line 2), so think twice. Cold: staying costs the same rewrite, so go ahead.

- Source: the last main-thread assistant entry in `transcript_path` (sidechain and `<synthetic>` entries skipped). Expiry = the later of its `timestamp` and the last idle recap (`system`/`away_summary`, a model call over the same prefix that renews the TTL ~10 min into idle; off if recaps are disabled in `/config`) + TTL. TTL is 5m only when that request's write was purely `ephemeral_5m`; otherwise 1h.
- The statusline only re-renders on interaction, so press **Ctrl+C once** (it re-renders) right before deciding. The time is absolute so a stale view stays readable against the clock.
- Every uncertainty leans toward "warm". A stale view can show warm when the cache is actually cold, never the reverse (re-warming takes a request, and a request re-renders). The timestamp is response-end, which is later than the TTL refresh. An unknown TTL tier counts as 1h. The server may also evict early. All of these only cost you an unnecessary second thought.

### 7d active-time computation

The 7d window's time marker is not computed against wall-clock time (168h). Instead it counts only **working hours**:

- Default working window: 09:00–22:00 (13h/day)
- 7-day total active time ≈ 91h
- Minute-accurate: each calendar day's working window is intersected with the 7d rolling window

This makes the time marker reflect "at a normal usage pace, how much should I have consumed by now".

### Fable overlay

The 7d bar also carries Fable's own weekly limit: a `┃` at Fable's percentage, plus `fbNN%` after the 7d percentage.

```
7d ██████░│░░░┃░░ 43% fb80% (3d0h)    Fable ahead of the time marker
7d ██┃███░│░░░░░░ 43% fb20% (3d0h)    Fable behind it
7d ██████░┃░░░░░░ 43% fb50% (3d0h)    same cell as the time marker → ┃ wins
7d ██████░│░░░░░┃ 43% fb123% (3d0h)   past 100% → pinned to the last cell
7d ██████░│░░░░░░ 43% fb-- (3d0h)     no data yet
```

- **One time marker for both.** Fable's weekly window resets at the same moment as the 7d window, so `┃` right of `│` means Fable is burning faster than the week is passing. `┃` and `fbNN%` share a color, picked with the same rules as the other bars against that shared time progress.
- **Stale data dims.** If the last successful fetch is older than 1h, `┃` and `fbNN%` render DIM. That beats the off-hours red.

**Where the number comes from.** Not stdin: CC's statusline JSON only exposes `rate_limits.five_hour` / `seven_day` (checked through CC 2.1.280), even though CC tracks Fable internally. The script reads the same endpoint the `/usage` panel does — `GET https://api.anthropic.com/api/oauth/usage` — and takes the `limits[]` entry with `kind: "weekly_scoped"` and `scope.model.display_name: "Fable"`. The endpoint is **undocumented**; if its shape changes, the overlay degrades to stale data and then `fb--`, never a broken line.

**Refresh model** (same shape as the ccusage cost cache):

- Rendering only reads `~/.claude/statusline-usage-cache.json` (percentage + reset time, nothing else).
- Once the last attempt is older than `STATUSLINE_USAGE_TTL` (default 300s), one background subshell refreshes it; a `~/.claude/statusline-usage-cache.lock` directory keeps concurrent statuslines from piling up. Failed attempts (401 / 429 / offline) still count as attempts, so failures back off one TTL instead of retrying every render.
- If the API can't be used, it falls back to the copy CC itself keeps in `~/.claude.json` (`cachedUsageUtilization`, written whenever CC fetches usage, e.g. on `/usage`) — only if it's for the logged-in account and newer than what the cache has.

**Token handling.** The refresher reads the OAuth access token CC stores in the macOS keychain (`Claude Code-credentials`):

- The token is passed to `curl` on stdin (`--config -`), never on the command line, so it doesn't show up in `ps`. It is never written to disk or to any log.
- The script **never refreshes the token.** Refreshing rotates the refresh token and would leave CC's own stored copy invalid. If the token has expired, the API step is skipped until CC refreshes it on its next request; the fallback above covers the gap.

### Non-working-hours warning

When the current time is outside the working window (default 22:00–09:00), the 5h and 7d bars and percentages — and the Fable overlay — **force red**, reminding you that you're running off-hours.

### Upgrade hint

The yellow `↑` after `vX.Y.Z` means a **newer Claude Code is sitting on disk** but this session is still running the version it loaded at startup. CC won't hot-swap mid-process — restart picks it up. No `↑` = you're already on the newest installed.

The check probes common install layouts and stops at the first hit; "newest" is whichever of those reports a version strictly greater than the running one:

| Layout | Path |
|---|---|
| Native installer (multi-version dir) | `~/.local/share/claude/versions/<X.Y.Z>` |
| Migration / `claude-bin` installer | `~/.claude/local/node_modules/@anthropic-ai/claude-code/` |
| npm global | `~/.npm-global/lib/node_modules/...` |
| bun global | `~/.bun/install/global/node_modules/...` |
| Homebrew | `/opt/homebrew/lib/node_modules/...` |
| `/usr/local` | `/usr/local/lib/node_modules/...` |

If none of those exist, or stdin has no `version` field (older CC builds), the `vX.Y.Z` segment and `↑` are simply omitted — no false alarms.

### Last-reply timestamp

`⏱ MM-DD.HH:MM` at the tail of line 2 shows **when CC last finished replying** in the current session. Populated by the `Stop` hook [`hooks/last-reply.sh`](../hooks/last-reply.sh), which stamps `~/.claude/session-meta/<session_id>/last-reply.json` on every reply. The segment is hidden until that hook has fired at least once.

Per-session, so concurrent sessions each show their own last-reply time; the hook also prunes session dirs idle > 30 days so state never grows unbounded.

### Today & month-to-date cost

The line-1 cost field expands from the single session number to `$session / $today / $month`, so you always see the **three** horizons that actually drive decisions: "how expensive is this reply", "how much have I already spent today", and "where am I for the month".

- **Session** (`$3.42`, yellow) — live from `cost.total_cost_usd` on every render, two-decimal precision for values under $10.
- **Today** and **month-to-date** (`$54.3 / $3.2K`, dim) — computed by [`ccusage`](https://github.com/ryoppippi/ccusage), which reads the raw transcripts under `~/.claude/projects/*/*.jsonl` and multiplies tokens by current model pricing. Dollar amounts match what `ccusage daily` / `ccusage monthly` would print. If `ccusage` isn't on `PATH` (or under `~/.bun/bin/`), both slots degrade to `--`; the rest of the statusline is unaffected.
- **Caching model** — each render reads `~/.claude/ccusage-cache.json` (cheap). When the cache is older than `STATUSLINE_CCUSAGE_TTL` (default 600s), a backgrounded subshell forks `ccusage`, updates the cache with atomic rename, and exits — **rendering itself never blocks**. A `~/.claude/ccusage-cache.lock` directory (mkdir is atomic) prevents concurrent refreshers from piling up; a dead-lock >60s old is self-cleared.
- **Time zone** — `today` and `month` are bucketed by `STATUSLINE_CCUSAGE_TZ` (default = system TZ from `/etc/localtime`), so at Shanghai midnight, "today" resets to zero on the next refresh regardless of where the underlying JSONL timestamps live.

Cost of the extra feature: one `ccusage` subprocess per TTL window. Everything else is `jq` + `awk` on cached JSON — sub-millisecond per render.

## Install

### Requirements

- bash
- jq
- git (optional, for branch and diff display)
- [`ccusage`](https://github.com/ryoppippi/ccusage) (optional, for the today / month-to-date cost display — `bun add -g ccusage` or `npm install -g ccusage`; without it, those two slots show `--`)
- `curl` + a Claude.ai subscription login in CC (for the [Fable overlay](#fable-overlay); without them it shows `fb--`)
- macOS (`date -j -f` is used in the active-time calculation; `security` reads the keychain for the Fable overlay)

### Configuration

1. Copy the script into your Claude Code config directory:

   ```bash
   cp statusline.sh ~/.claude/statusline-command.sh
   ```

2. Wire it up in `~/.claude/settings.json`:

   ```json
   {
     "statusline": {
       "command": "bash ~/.claude/statusline-command.sh"
     }
   }
   ```

> If you use the repo's top-level `install.sh --statusline`, both steps above happen automatically — `settings.json` ends up pointing at the script inside this repo directly (no copy needed).

### Environment variables

| Variable | Default | Description |
|------|--------|------|
| `STATUSLINE_WORK_START` | `9` | Working window start (hour, 0–23) |
| `STATUSLINE_WORK_END` | `22` | Working window end (hour, 0–23) |
| `STATUSLINE_CCUSAGE_TTL` | `600` | Background-refresh interval for the today/month cost (seconds) |
| `STATUSLINE_CCUSAGE_TZ` | system TZ (from `/etc/localtime`) | IANA zone (e.g. `Asia/Shanghai`) used to bucket today/month, matching what `ccusage --timezone` reports |
| `STATUSLINE_USAGE_TTL` | `300` | Seconds between background refresh attempts for the Fable overlay |

Example: set working hours to 8:00–21:00:

```bash
export STATUSLINE_WORK_START=8
export STATUSLINE_WORK_END=21
```

## Data sources

Most fields come from the JSON Claude Code pipes in on stdin. Exceptions:

- **Today / month-to-date cost** — computed by `ccusage` reading `~/.claude/projects/*/*.jsonl` (see [Today & month-to-date cost](#today--month-to-date-cost) above).
- **Last-reply timestamp** — read from `~/.claude/session-meta/<session_id>/last-reply.json`, which the `Stop` hook [`hooks/last-reply.sh`](../hooks/last-reply.sh) writes on every reply (see [Last-reply timestamp](#last-reply-timestamp) above).
- **Fable overlay** — read from `~/.claude/statusline-usage-cache.json`, refreshed in the background from `GET /api/oauth/usage` (see [Fable overlay](#fable-overlay) above).

Stdin-driven fields:

| JSON path | Use |
|-----------|------|
| `model.display_name` | Model name |
| `version` | Claude Code CLI version of the running session (used together with the on-disk probe to render the `↑` upgrade hint — see [Upgrade hint](#upgrade-hint)) |
| `workspace.current_dir` | Current directory |
| `context_window.used_percentage` | Context usage |
| `context_window.context_window_size` | Context window size |
| `context_window.total_input_tokens` | Cumulative input tokens (parsed but not displayed by default; re-enable the `↑${SEND_FMT} ↓${RECV_FMT}` line in `statusline.sh` to show) |
| `context_window.total_output_tokens` | Cumulative output tokens (same as above) |
| `context_window.current_usage.input_tokens` | Last-call non-cached input tokens (cache hit % numerator input) |
| `context_window.current_usage.cache_creation_input_tokens` | Last-call tokens written to cache |
| `context_window.current_usage.cache_read_input_tokens` | Last-call tokens read from cache |
| `cost.total_cost_usd` | Session cost (estimate; not a bill for Pro/Max subscribers) |
| `cost.total_api_duration_ms` | Cumulative time spent waiting on the API this session |
| `cost.total_duration_ms` | Session wall-clock time |
| `rate_limits.five_hour.*` | 5h rolling-window usage + reset time |
| `rate_limits.seven_day.*` | 7d window usage + reset time |

> `rate_limits` is populated only on Claude.ai Pro/Max subscriptions, and only after the first API response in the session.
