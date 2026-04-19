# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, breaking changes (hook stdin field adaptations, settings.json
schema shifts) may land in minor versions.

## [Unreleased]

### Fixed
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

[Unreleased]: https://github.com/taige/claude-utils/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/taige/claude-utils/releases/tag/v0.1.0
