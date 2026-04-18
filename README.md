# claude-utils

Personal Claude Code extensions: worktree lifecycle hooks and a custom terminal statusline.

> Small-scale personal tooling, but every "gotcha I hit" is packaged as a reusable component. Fork it, tweak it, file issues.
>
> **License**: MIT · [中文 README](README.zh.md)

## Install — 30 seconds, paste into Claude Code

Open Claude Code and paste this. Claude does the rest.

> Install claude-utils:
> 1. Run `git clone --depth 1 https://github.com/taige/claude-utils.git ~/.claude/claude-utils`
> 2. Run `~/.claude/claude-utils/install.sh --all`
> 3. If the install script reports `Conflict` or `jq is required`, read `~/.claude/claude-utils/docs/SETTINGS_MERGE.md` and help me merge `~/.claude/settings.json` manually (create a timestamped backup first).
> 4. When install is done, tell me to restart the Claude Code session (or run `/hooks`) for hooks to take effect.

### Or install manually

```bash
git clone --depth 1 https://github.com/taige/claude-utils.git ~/.claude/claude-utils
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

### statusline/statusline.sh — dual-line statusline

Line 1: model, directory, git branch + diff, token throughput, cost.
Line 2: context window + 5h and 7d rate-limit bars, each overlaid with a time-progress marker (`│`) so you can see at a glance whether your burn rate is sustainable.

Full details: [`statusline/README.md`](statusline/README.md).

## Architecture

| Location | Role |
|---|---|
| This repo (recommend cloning to `~/.claude/claude-utils/`) | **Source + runtime** — `settings.json` references scripts here directly |
| `~/.claude/settings.json` | CC's config; `install.sh` merges entries idempotently |
| `~/.claude/worktree-hook.log` | stdin JSON of every hook invocation — first stop when debugging |

```
claude-utils/
├── hooks/
│   ├── worktree-create.sh
│   └── worktree-remove.sh
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
