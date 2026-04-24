# claude-utils

Personal Claude Code extensions: worktree lifecycle hooks and a custom terminal statusline.

<p align="center">
  <img src="docs/images/statusline.png" alt="claude-utils statusline — dual-line layout showing Opus 4.7 (1M context), branch and diff, token throughput and cost on line 1; context-window and 5h/7d rate-limit progress bars with time markers on line 2" width="820" />
</p>

> Small-scale personal tooling, but every "gotcha I hit" is packaged as a reusable component. Fork it, tweak it, file issues.
>
> **License**: MIT · [中文 README](README.zh.md)

## Install — 30 seconds, paste into Claude Code

Open Claude Code and paste this. Claude does the rest.

> Install claude-utils:
> 1. Run `git clone --depth 1 https://github.com/ericwu917/claude-utils.git ~/.claude/claude-utils`
> 2. Run `~/.claude/claude-utils/install.sh --all`
> 3. If the install script reports `Conflict` or `jq is required`, read `~/.claude/claude-utils/docs/SETTINGS_MERGE.md` and help me merge `~/.claude/settings.json` manually (create a timestamped backup first).
> 4. When install is done, tell me to restart the Claude Code session (or run `/hooks`) for hooks to take effect.

### Or install manually

```bash
git clone --depth 1 https://github.com/ericwu917/claude-utils.git ~/.claude/claude-utils
~/.claude/claude-utils/install.sh --all         # default: hooks + statusline
~/.claude/claude-utils/install.sh --hooks       # hooks only
~/.claude/claude-utils/install.sh --statusline  # statusline only
~/.claude/claude-utils/install.sh --dry-run     # show the diff, don't write
```

- Requires `bash`, `jq`, `git` (the statusline additionally uses macOS `date -j -f`).
- `install.sh` points `settings.json` **directly at scripts in the repo**, no copying. `git pull` in the clone directory upgrades in place — no need to rerun install.
- Before writing, the script backs up your existing settings to `settings.json.bak.<timestamp>`.
- Idempotent: reruns just refresh claude-utils' own entries with the current path. If a slot already holds a non-claude-utils entry, the script warns and skips — **your config is never overwritten**.

## Components

### hooks/worktree-create.sh — `WorktreeCreate`

Prefix-driven base branch selection, plus a date stamp:

| Input `name` | Branch | Base |
|---|---|---|
| `feat/<rest>` | `feat/YYMMDD-<rest>` | `origin/develop` |
| `hotfix/<rest>` | `hotfix/YYMMDD-<rest>` | `origin/master` |
| anything else | `worktree-<name>` | `origin/HEAD` (fallback) |

Example: `claude -w feat/kill-mutants-s2` → branch `feat/260418-kill-mutants-s2`, worktree at `<repo>/.claude/worktrees/feat/260418-kill-mutants-s2/`. If the expected base is missing (e.g. the repo has no `origin/develop`), the hook falls back to `origin/HEAD` — so it stays useful in projects that don't follow git-flow.

### hooks/worktree-remove.sh — `WorktreeRemove`

Paired cleanup. Runs `git worktree remove` (**without `--force`**, so dirty worktrees are preserved) + `git branch -D` + empty-parent-directory cleanup. Because CC invokes this hook with cwd set to the worktree being removed, every destructive git op is routed through `git -C "$MAIN_REPO"` — git refuses to self-delete its cwd or a checked-out branch, so the hook does the work from the main repo instead.

### hooks/last-reply.sh — `Stop`

Records when CC last finished replying in the current session so `statusline/statusline.sh` can render a `⏱ HH:MM` segment at the tail of line 2. Glance at the status bar after stepping away and you see exactly when CC last responded; subtract from your watch to gauge how long ago.

Absolute wall-clock time, by design: the statusline only redraws on interaction, so anything relative (`Xh ago`, `just now`) would be computed while the reply is fresh and then freeze on-screen for the whole time you're away — misleading precisely when you need it to be right.

State lives under `~/.claude/session-meta/<session_id>/last-reply.json` (shape `{"at": <epoch>}`). Layout is one directory per session with one file per "feature"; follow-up hooks can drop their own files (`last-user-prompt.json`, etc.) alongside without coordinating. Session directories idle > 30 days are pruned on every Stop. Writes are atomic; the hook always `exit 0` so it can never stall a reply; rare errors go to `~/.claude/last-reply-hook.log`.

### statusline/statusline.sh — dual-line statusline

Line 1: model, directory, git branch + diff, cache hit rate, cost / API time / wall time.
Line 2: context window + 5h and 7d rate-limit bars, each overlaid with a time-progress marker (`│`) so you can see at a glance whether your burn rate is sustainable. Plus `⏱ HH:MM` at the tail when the Stop hook above is installed.

Full details: [`statusline/README.md`](statusline/README.md).

## Architecture

| Location | Role |
|---|---|
| This repo (recommend cloning to `~/.claude/claude-utils/`) | **Source + runtime** — `settings.json` references scripts here directly |
| `~/.claude/settings.json` | CC's config; `install.sh` merges entries idempotently |
| `~/.claude/session-meta/<session_id>/` | Per-session state files written by hooks (e.g. `last-reply.json`) and read by the statusline |
| `~/.claude/worktree-hook.log` | stdin JSON of every worktree hook invocation — first stop when debugging |
| `~/.claude/last-reply-hook.log` | non-fatal errors from `last-reply.sh` (missing `session_id`, write failures) |

```
claude-utils/
├── hooks/
│   ├── worktree-create.sh
│   ├── worktree-remove.sh
│   └── last-reply.sh
├── statusline/
│   ├── statusline.sh
│   └── README.md
├── docs/
│   └── SETTINGS_MERGE.md      # manual-merge guide for conflict cases
├── install.sh
├── CHANGELOG.md
├── LICENSE
├── CLAUDE.md                   # repo notes for Claude Code instances
└── README.md
```

## Pitfalls worth knowing before you write your own hooks

- **`WorktreeCreate` stdin**: the worktree name is at top-level `.name`, **not** `.tool_input.name`.
- **`WorktreeRemove` stdin**: the path field is `.worktree_path` (snake_case), not `.path` / `.worktreePath`.
- **`WorktreeRemove` cwd trap**: CC invokes the hook from inside the worktree being removed. `git worktree remove` and `git branch -D` both fail from that cwd because git refuses to self-delete its cwd or a checked-out branch. Use `git -C <main-repo>`.
- **Pairing requirement**: if you configure `WorktreeCreate`, you **must** also configure `WorktreeRemove`. CC's built-in cleanup does not run on `/exit` once a custom `WorktreeCreate` is set — even a clean worktree won't auto-remove. Undocumented but reproducible.

## Roadmap

- [x] `install.sh` + paste-prompt one-shot install
- [x] English README
- [ ] `uninstall.sh` / `install.sh --update`
- [ ] shellcheck + shfmt CI

PRs and issues welcome.

## License

MIT — see [LICENSE](LICENSE).
