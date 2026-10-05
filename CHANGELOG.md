# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, breaking changes (hook stdin field adaptations, settings.json
schema shifts) may land in minor versions.

## [Unreleased]

## [0.3.0] - 2026-10-04

### Breaking
- **`statusline.sh` is retired in favor of the `statusband` mod.**
  `install.sh --all` now installs the hooks and the mod, no longer the
  statusline; `statusline.sh` and its `last-reply.sh` Stop hook stay as a
  fallback behind `install.sh --statusline`.
- **`install.sh` copies the runtime into `~/.claude/`** (`hooks/*.sh`,
  `mods/statusband/`, `statusline-refresh-caches.sh`) instead of pointing
  `settings.json` at the repo working tree, so the runtime is independent
  of whatever the checkout is doing. Upgrade = `git pull` + rerun
  `install.sh`. Hook commands are written as `"$HOME/.claude/hooks/…"`.

### Added
- `mods/statusband` — a Claude Code mod drawing a status band above the
  prompt, in the CLI and the desktop app:
  - CLI: `statusline.sh`'s two lines (model + version `↑`, directory as a
    `file://` link that opens Finder, git, cache hit + `⏳` expiry, cost;
    context / 5h / 7d bars with Fable on 7d). Bars are `Raster` rows at
    1/8-cell resolution: a solid track, a lighter elapsed-time band, and
    usage past the pace drawn a shade darker. Lines are fitted to the
    band's width, dropping detail before bars.
  - Desktop: what the app doesn't already show, with Svg bars and line
    icons; the `↗` after the directory opens it in Finder.
  - Per-account data (5h/7d, Fable) always comes from the session's own
    account (`$.session.usage()`, `$.session.authorize()` +
    `$.http.fetch`), never the keychain — the CLI and the app may be
    signed in as different accounts. Fable readings are shared across
    sessions of one account through `$.store`.
  - Reminders: a toast ten minutes before a 1h prompt cache lapses (plus a
    Discord message when `~/.config/discord-webhook` exists), and a toast
    each time the context fill crosses 60% upward.
  - Settings via `env`: `STATUSLINE_WORK_START` / `_END`,
    `STATUSBAND_CTX_WARN_PCT`, `STATUSBAND_CACHE_WARN_MIN`. The CLI bar
    track follows CC's theme.
  - Render and reminder tests under `mods/statusband/tests/`
    (`claude plugin test mods/statusband`).
- `install.sh --mods`: installs the mod and appends it to
  `env.CLAUDE_CODE_PLUGIN_DIRS` (other folders there are kept);
  `--dry-run` now also reports what would be copied.
- `statusline/statusline-refresh-caches.sh`: the ccusage-cost and
  Fable-usage refreshers, split out of `statusline.sh` (which still
  renders the same); each gates on its TTL and takes its own lock, so the
  mod reuses the ccusage half.
- `hooks/guard-worktree-edits.sh` — a `PreToolUse` guard (Edit / Write /
  MultiEdit / NotebookEdit) that asks before an edit lands outside the
  session's own tree, in both directions (worktree → main repo and main
  repo → worktree). `install.sh` wires it, with a new `matcher` argument
  on `upsert_hook`.
- `hooks/worktree-create.sh`: desktop auto-named worktrees (a random slug
  with an empty `transcript_path`) become `claude/<YYMMDD>-<slug>`
  branches in a flat `<YYMMDD>-<slug>` directory.
- `hooks/worktree-create.sh`: the parent repo's local-scope MCP servers
  are mirrored into the worktree's `.mcp.json` (hidden via
  `info/exclude`; a tracked `.mcp.json` is left alone).
- `statusline/statusline.sh`: Fable weekly usage overlaid on the 7d bar;
  prompt-cache expiry (`⏳HH:MM` / `❄cold`) after the hit rate.
- `hooks/worktree-create.sh`: `feature/<rest>` (git-flow's default prefix)
  now follows the same rules as `feat/<rest>` — branch
  `feature/<YYMMDD>-<rest>` off `origin/develop`, worktree at
  `feature/<YYMMDD>-<rest>/`, and an existing `feature/<date>-<rest>` from
  any day is reused. `worktree-remove.sh` treats these branches as
  hook-managed.
- `statusline/statusline.sh`: model bracket now shows the running Claude Code
  CLI version (`[Opus 4.7 v2.1.139]`), sourced from the new `version` field
  on the stdin payload. When a strictly newer CC is already installed on
  disk — but this session is still on the older one CC loaded at startup —
  a yellow `↑` appears right after the version (`v2.1.139↑`) as a nudge to
  restart. The probe is install-method agnostic: it tries the native
  multi-version layout (`~/.local/share/claude/versions/<X.Y.Z>`) first,
  then falls back to `package.json` lookups under common npm / bun /
  Homebrew / `/usr/local` prefixes. Missing layouts (or older CC builds
  that don't send `version`) silently omit the segment — no false alarms.

### Changed
- `statusline/statusline.sh`: api / wall durations moved to line 2; the
  80%-based "usable context" bracket dropped; the `⏱` stamp shows
  `MM-DD.HH:MM` so a stamp from before midnight isn't read as today's.
- `hooks/worktree-create.sh`: `-w <name>` enters an existing worktree on
  an exact path match whatever its branch, instead of erroring.

### Fixed
- `install.sh` wrote the statusline under `statusline` — CC reads
  `statusLine` with `type: command` — so the scripted install never took;
  and a directory's change check was masked by `pipefail`.
- `hooks/worktree-remove.sh` only removes worktrees on branches the
  create hook manages: a worktree entered on `main` was torn down, and its
  branch force-deleted, on exit.
- `hooks/worktree-remove.sh` resolves the main repo path whole when it
  contains spaces (it was cut at the first one, and nothing was removed).

## [0.2.0] - 2026-04-25

### Added
- `hooks/last-reply.sh` — new `Stop` hook that records when CC last
  finished replying in each session; `statusline/statusline.sh` appends
  a `⏱ HH:MM` segment to the tail of line 2 so you can see at a glance
  when CC last responded in the current session.
- `hooks/last-reply.sh` state lives under
  `~/.claude/session-meta/<session_id>/last-reply.json`
  (`{"at": <epoch>}`). Layout is one directory per session, one file per
  "feature" — follow-up hooks (e.g. a future `last-user-prompt.json`)
  drop their files alongside without needing to coordinate key
  namespaces or serialize writes. Session directories idle > 30 days
  are pruned automatically on every Stop, so nothing grows unbounded.
  `install.sh` registers the hook under `hooks.Stop`; conflicts with
  pre-existing non-claude-utils `Stop` entries surface and skip (same
  basename-match rule as `WorktreeCreate` / `WorktreeRemove`).
- `statusline/statusline.sh`: line-1 cost field now shows
  `$session / $today / $month` (e.g. `$3.42 / $54.3 / $3.2K`), giving the
  three horizons that actually drive usage decisions — per-reply, today's
  burn, month-to-date. Session is live from stdin; today and month come
  from [`ccusage`](https://github.com/ryoppippi/ccusage) which reads the
  raw transcripts under `~/.claude/projects/*/*.jsonl` and multiplies
  tokens by current model pricing. Results are cached in
  `~/.claude/ccusage-cache.json` with a TTL (default 600s, override via
  `STATUSLINE_CCUSAGE_TTL`) and refreshed lazily in a backgrounded
  subshell, so statusline rendering itself never blocks on `ccusage`
  (which takes a few seconds on a cold pricing fetch). Concurrent
  refreshers are serialized via a `mkdir` lock with a 60s self-heal.
  Bucket TZ for "today" / "month" is `STATUSLINE_CCUSAGE_TZ` (default =
  system TZ from `/etc/localtime`) so values line up with what
  `ccusage --timezone` reports. If `ccusage` isn't on `PATH` (nor under
  `~/.bun/bin/`), both slots gracefully degrade to `--` and the rest of
  the statusline is unaffected. Compact `$` format: `$X.XX` < 10,
  `$XX.X` < 100, `$XXX` < 1000, `$X.XK` ≥ 1000. Durations (`api / wall`)
  move to their own `|`-separated segment on line 1.
- `statusline/statusline.sh`: cost field on line 1 now expands to
  `$X.XX / <api_duration> / <wall_duration>` (e.g. `$4.34 / 4h10m / 1d2h`),
  giving a quick read on how much of the session's wall-clock time was
  actually spent waiting on the model. Two-tier minute-precision duration
  format: `XdYh` at ≥24h, `XhYm` otherwise. The formatter is shared with
  the existing `5h`/`7d` rate-limit countdowns — `fmt_remaining` now
  delegates to it, eliminating the previous near-duplicate formatter.
  Sources `cost.total_api_duration_ms` (newly parsed) and the existing
  `cost.total_duration_ms`. The previously-commented-out line-2 duration
  slot has been retired in favor of this inline placement.
- `statusline/statusline.sh`: line 1 now shows prompt cache hit rate as
  `💾 XX%` in the slot previously occupied by cumulative `↑input ↓output`
  tokens. Computed from `context_window.current_usage` as
  `cache_read / (input + cache_creation + cache_read)` — so it reflects
  **the last API call only** (stdin doesn't expose cumulative cache totals).
  Inverse color scale calibrated against observed Claude Code steady state:
  ≥95% green, 80–95% yellow, 50–80% orange, <50% red; displayed as `💾 --`
  before the first API call, when `current_usage` is `null`. The old
  cumulative-token display is kept as a one-line comment in the script for
  easy re-enable. Anthropic does not publish a cache-hit target — thresholds
  are empirical, not official.
- `statusline/statusline.sh`: line-1 directory name is now a cmd/modifier+click
  hyperlink that opens the folder in Finder. Implemented via an OSC 8 escape
  (`file://` URL) around `DIR_NAME`; unsupported terminals (Terminal.app)
  silently ignore it. Uses BEL as the OSC terminator so `echo -e` doesn't
  interpret `\033\\<text>` as a `\c` stop-output sequence and truncate the
  rest of the line.

### Changed
- `hooks/worktree-remove.sh` now gates `git branch -D` on whether the
  branch's tip is preserved elsewhere — merged into `develop` / `master`
  / `main` (checked on `origin/*` first, local fallback) or reachable
  from any remote ref. Unmerged, unpushed branches are kept; the create
  hook's reuse logic reattaches a worktree on the next
  `claude -w <same-name>`. Old behaviour was unconditional `branch -D`,
  which could drop unrecoverable work on session exit.

### Fixed
- `hooks/worktree-remove.sh`: surface the real failure reason when
  `git worktree remove` is refused (typically: dirty/untracked files such
  as `venv/` or `node_modules/`). Previously the hook echoed a generic
  "likely dirty" message to stderr only and `exit 0`'d, so Claude Code
  saw it as success and the user got no indication the worktree was
  preserved. Now the hook captures git's actual stderr ("fatal: '...'
  contains modified or untracked files, use --force to delete it"), echoes
  it verbatim plus a force-delete hint, writes it to
  `~/.claude/worktree-hook.log`, and `exit 1`s so CC shows the failure.
  Successful removes also log a confirmation line. Never auto-`--force`:
  preserving dirty worktrees is the intended safety behavior; only the
  silent-ignore was the bug.
- `hooks/worktree-create.sh`: strip a leading `worktree-` prefix on the
  plain (non-`feat/`, non-`hotfix/`) case so `claude -w worktree-foo` (a
  branch name pasted from `git branch`) resolves to the same worktree as
  `claude -w foo` instead of creating a second, double-prefixed
  `worktree-worktree-foo` branch at `.claude/worktrees/worktree-foo/`.
- `hooks/worktree-create.sh`: re-entering an existing worktree name no longer
  aborts with `fatal: a branch named '...' already exists`. The hook now
  detects worktree/branch state and either re-uses the standard-path
  worktree, attaches to an orphan branch, or — when the branch is already
  checked out at a different path under `$REPO_ROOT/.claude/worktrees/`
  (including Claude Code's own default `.claude/worktrees/<name>/` layout
  from before this hook was installed, or legacy prefixed paths from earlier
  hook runs) — falls back to the existing path rather than creating a second
  worktree. Auto-prunes stale registrations whose directory was removed
  manually. Errors only when the path holds a different branch or the branch
  is checked out truly outside our worktrees root. For `feat/<x>` /
  `hotfix/<x>` inputs, an existing `feat/<YYMMDD>-<x>` branch (any date
  stamp) is reused in preference to creating a fresh `feat/<today>-<x>`;
  non-date-stamped branches such as `feat/cleanup-<x>` are intentionally
  ignored to stay in sync with `worktree-remove.sh`'s cleanup regex.
  As part of this work, new plain-name worktrees (non-`feat/`, non-`hotfix/`)
  now land at `.claude/worktrees/<name>/` to match Claude Code's own default
  `-w` layout; the branch name keeps its `worktree-` prefix so hook-created
  branches remain easy to pick out in `git branch`. (#3)
- `statusline/statusline.sh`: rate-limit bar (`5h` / `7d`) time-marker
  misalignment on macOS. The previous implementation used `${var:offset:length}`
  string slicing, which bash 3.2 (`/bin/bash`) interprets as bytes; since the
  fill characters `█` and `░` are 3 bytes each in UTF-8, a slice could cut a
  codepoint in half and the terminal would drop the orphan bytes, collapsing
  the bar by one column. Now constructed by per-character loop. (#1)

## [0.1.0] - 2026-04-18

### Added
- `hooks/worktree-create.sh` — `WorktreeCreate` hook: prefix-driven base branch
  (`feat/*` → `origin/develop`, `hotfix/*` → `origin/master`, else `origin/HEAD`)
  with date-stamped branch names.
- `hooks/worktree-remove.sh` — paired `WorktreeRemove` hook that avoids the
  self-delete cwd trap by routing git ops through the main repo.
- `statusline/statusline.sh` — dual-line terminal statusline with context
  window, 5h and 7d rate-limit bars, and work-hour-aware time markers.
- `install.sh` — idempotent `~/.claude/settings.json` merge via `jq`. Supports
  `--all` / `--hooks` / `--statusline`, `--dry-run`, `--quiet`. Skips (does not
  overwrite) non-claude-utils entries and points the user at
  `docs/SETTINGS_MERGE.md` for manual resolution.
- `docs/SETTINGS_MERGE.md` — manual merge guide + Claude-driven merge prompt.
- `LICENSE` (MIT), `.gitignore`.
- English-primary documentation (`README.md`, `statusline/README.md`,
  `docs/SETTINGS_MERGE.md`), with Chinese versions preserved at the `.zh.md`
  siblings and cross-linked at the top of each file.

[Unreleased]: https://github.com/ericwu917/claude-utils/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ericwu917/claude-utils/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ericwu917/claude-utils/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ericwu917/claude-utils/releases/tag/v0.1.0
