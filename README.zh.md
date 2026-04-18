# claude-utils

个人 Claude Code 扩展积累：worktree 生命周期 hooks、双行状态栏等。

> **现状**：给个人用，但每一处"踩坑点"都写成了可复用组件。欢迎拿走、改造、提 issue。
>
> **License**：MIT · [English README](README.md)

## 安装（30 秒，在 Claude Code 里贴一段）

打开 Claude Code，把下面这段贴进去，让 Claude 自己做完：

> 帮我装 claude-utils：
> 1. 跑 `git clone --depth 1 https://github.com/taige/claude-utils.git ~/.claude/claude-utils`
> 2. 跑 `~/.claude/claude-utils/install.sh --all`
> 3. 如果 install.sh 报了 "Conflict" 或 "jq is required"，读 `~/.claude/claude-utils/docs/SETTINGS_MERGE.md` 帮我手动合并 `~/.claude/settings.json`（合并前备份）
> 4. 装完告诉我需要重启 Claude Code 会话（或运行 `/hooks` 重载）hooks 才生效

### 或：手动安装

```bash
git clone --depth 1 https://github.com/taige/claude-utils.git ~/.claude/claude-utils
~/.claude/claude-utils/install.sh --all         # 默认装 hooks + statusline
~/.claude/claude-utils/install.sh --hooks       # 只装 hooks
~/.claude/claude-utils/install.sh --statusline  # 只装 statusline
~/.claude/claude-utils/install.sh --dry-run     # 只看 diff 不写
```

- 依赖：`bash`、`jq`、`git`（statusline 还需要 macOS `date -j -f`）
- `install.sh` 直接让 `settings.json` 里的路径**指向仓库本地文件**（不拷贝）。以后 `git pull` 即升级，不用重跑 install
- 写 `settings.json` 前自动备份到 `settings.json.bak.<timestamp>`
- 幂等：重复跑只会把自己的条目替换成最新路径，不会重复注册；遇到冲突（用户已有非 claude-utils 的同槽位配置）会打印警告并跳过，不覆盖

## 组件

### hooks/worktree-create.sh — `WorktreeCreate`

按前缀自动选 base branch 并注入日期戳：

| 输入 name | 实际 branch | base |
|---|---|---|
| `feat/<rest>` | `feat/YYMMDD-<rest>` | `origin/develop` |
| `hotfix/<rest>` | `hotfix/YYMMDD-<rest>` | `origin/master` |
| 其他 | `worktree-<name>` | `origin/HEAD`（fallback） |

示例：`claude -w feat/kill-mutants-s2` → branch `feat/260418-kill-mutants-s2`，worktree 路径 `<repo>/.claude/worktrees/feat/260418-kill-mutants-s2/`。Base 不存在时自动回退到 `origin/HEAD`，保证脚本在不走 git-flow 的项目里也能用。

### hooks/worktree-remove.sh — `WorktreeRemove`

配对清理。`git worktree remove`（**不带 `--force`**，dirty worktree 会保留）+ `git branch -D` + 清理空父目录。CC 调用此 hook 时 cwd 就是被删的 worktree 本身，所以脚本内部所有 git 写操作都通过 `git -C "$MAIN_REPO"` 从主 repo 上下文执行。

### statusline/statusline.sh — 双行状态栏

第一行：模型、目录、git 分支 + diff、token 吞吐、费用。
第二行：上下文窗口进度条、5h/7d 速率限制进度条（叠加时间进度标记 `│`，一眼看出当前消耗速率是否可持续）。

详见 [`statusline/README.md`](statusline/README.md)。

## 架构

| 位置 | 角色 |
|---|---|
| 本仓库（建议克隆到 `~/.claude/claude-utils`） | **源码 + 运行时**：`settings.json` 直接引用这里的脚本 |
| `~/.claude/settings.json` | CC 的配置，由 `install.sh` 幂等合并 |
| `~/.claude/worktree-hook.log` | 两个 hook 的 stdin JSON 日志，排查问题用 |

```
claude-utils/
├── hooks/
│   ├── worktree-create.sh
│   └── worktree-remove.sh
├── statusline/
│   ├── statusline.sh
│   └── README.md
├── docs/
│   └── SETTINGS_MERGE.md      # 冲突时手动合并指南
├── install.sh
├── CHANGELOG.md
├── LICENSE
├── CLAUDE.md                   # 给 Claude Code 看的仓库说明
└── README.md
```

## 踩坑记录（写 hook 时值得记住）

- **Create hook 的 stdin**：`name` 字段在**顶层** `.name`，不在 `.tool_input.name`
- **Remove hook 的 stdin**：`.worktree_path`（snake_case），不是 `.path` / `.worktreePath`
- **Remove hook 的 cwd 陷阱**：CC 从被删 worktree 内部调用，直接跑 git 会尝试自删 cwd / 自删 checked-out branch，都会被 git 硬拦。必须 `git -C <主 repo>`
- **WorktreeCreate 不配 WorktreeRemove 的后果**：CC 默认清理不跑了，干净 worktree 也不会自动删（官方文档未明说，实测确认）

## Roadmap

- [x] `install.sh` + paste-prompt 一键装
- [ ] `uninstall.sh` / `install.sh --update`
- [ ] shellcheck + shfmt CI
- [ ] 英文 README

PR / issue welcome。

## License

MIT，见 [LICENSE](LICENSE)。
