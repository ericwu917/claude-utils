# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, breaking changes (hook stdin field adaptations, settings.json
schema shifts) may land in minor versions.

## [Unreleased]

### Changed
- Documentation switched to English-primary. The former Chinese `README.md`,
  `statusline/README.md`, and `docs/SETTINGS_MERGE.md` now live at
  `README.zh.md`, `statusline/README.zh.md`, and `docs/SETTINGS_MERGE.zh.md`
  respectively. Each version links to the other at the top.

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

[Unreleased]: https://github.com/taige/claude-utils/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/taige/claude-utils/releases/tag/v0.1.0
