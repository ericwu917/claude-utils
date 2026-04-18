# Custom Claude Code statusline

A dual-line terminal statusline for Claude Code. Real-time view of your work environment and session state.

[中文版](README.zh.md)

## Preview

<p align="center">
  <img src="../docs/images/statusline.png" alt="dual-line statusline preview — line 1 model, directory, branch + diff, token throughput, cost; line 2 context window + 5h/7d rate-limit bars with time markers" width="820" />
</p>

## Layout

### Line 1 — work environment

| Field | Description |
|------|------|
| `[Opus 4.6 (1M context)]` | Current model |
| `📁 project` | Project directory name |
| `🔀 master` | Git branch |
| `3 files +25 -10` | Uncommitted file changes (`git diff --shortstat HEAD`) |
| `↑50k ↓20k` | Cumulative input/output tokens this session |
| `$0.50` | Cumulative session cost |

### Line 2 — quota status

| Field | Description |
|------|------|
| `████░░░░ 35% (70k/200k)` | Context window usage (20-char bar) |
| `5h ██░│░░░ 27% (3h12m)` | 5-hour rolling-window usage (10-char bar) |
| `7d ████░│░░░░░░ 30% (5d8h)` | 7-day window usage (14-char bar) |

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

### 7d active-time computation

The 7d window's time marker is not computed against wall-clock time (168h). Instead it counts only **working hours**:

- Default working window: 09:00–22:00 (13h/day)
- 7-day total active time ≈ 91h
- Minute-accurate: each calendar day's working window is intersected with the 7d rolling window

This makes the time marker reflect "at a normal usage pace, how much should I have consumed by now".

### Non-working-hours warning

When the current time is outside the working window (default 22:00–09:00), the 5h and 7d bars and percentages **force red**, reminding you that you're running off-hours.

## Install

### Requirements

- bash
- jq
- git (optional, for branch and diff display)
- macOS (`date -j -f` is used in the active-time calculation)

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

Example: set working hours to 8:00–21:00:

```bash
export STATUSLINE_WORK_START=8
export STATUSLINE_WORK_END=21
```

## Data sources

All data comes from the JSON Claude Code pipes in on stdin. Key fields:

| JSON path | Use |
|-----------|------|
| `model.display_name` | Model name |
| `workspace.current_dir` | Current directory |
| `context_window.used_percentage` | Context usage |
| `context_window.context_window_size` | Context window size |
| `context_window.total_input_tokens` | Cumulative input tokens |
| `context_window.total_output_tokens` | Cumulative output tokens |
| `cost.total_cost_usd` | Session cost |
| `rate_limits.five_hour.*` | 5h rolling-window usage + reset time |
| `rate_limits.seven_day.*` | 7d window usage + reset time |

> `rate_limits` is populated only on Claude.ai Pro/Max subscriptions, and only after the first API response in the session.
