# claude-utils

个人 Claude Code 扩展积累：worktree 生命周期 hooks、输入框上方的状态横栏 mod（CLI 和桌面 app 通用）等。

<p align="center">
  <img src="docs/images/statusline.png" alt="claude-utils 状态栏 —— 第一行展示 Opus 4.7 (1M context)、分支与 diff、token 吞吐与费用；第二行展示上下文窗口 + 5h/7d 速率限制进度条（叠加时间进度标记）" width="820" />
</p>

> **现状**：给个人用，但每一处"踩坑点"都写成了可复用组件。欢迎拿走、改造、提 issue。
>
> **License**：MIT · [English README](README.md)

## 安装（30 秒，在 Claude Code 里贴一段）

打开 Claude Code，把下面这段贴进去，让 Claude 自己做完：

> 帮我装 claude-utils：
> 1. 跑 `git clone --depth 1 https://github.com/ericwu917/claude-utils.git ~/.claude/claude-utils`
> 2. 跑 `~/.claude/claude-utils/install.sh --all`
> 3. 如果 install.sh 报了 "Conflict" 或 "jq is required"，读 `~/.claude/claude-utils/docs/SETTINGS_MERGE.md` 帮我手动合并 `~/.claude/settings.json`（合并前备份）
> 4. 装完告诉我需要开一个新的 Claude Code 会话，hooks 和 mod 才生效

### 或：手动安装

```bash
git clone --depth 1 https://github.com/ericwu917/claude-utils.git ~/.claude/claude-utils
~/.claude/claude-utils/install.sh --all         # 默认装 hooks + mods
~/.claude/claude-utils/install.sh --hooks       # 只装 hooks
~/.claude/claude-utils/install.sh --mods        # 只装 statusband mod
~/.claude/claude-utils/install.sh --statusline  # 只装旧的 statusline.sh（备用，已被 mod 取代）
~/.claude/claude-utils/install.sh --dry-run     # 只看会拷什么、settings 的 diff，不写
```

- 依赖：`bash`、`jq`、`git`；mod 需要支持 hooks 模块（mods）的 Claude Code 版本
- `install.sh` 把运行时**拷贝**到 `~/.claude/`（`hooks/`、`mods/`、`statusline-refresh-caches.sh`），`settings.json` 指向拷贝，不指向仓库。运行时和工作树互不影响（仓库切分支不会弄坏正在跑的 session）；升级 = `git pull` 后重跑 `install.sh`
- 写 `settings.json` 前自动备份到 `settings.json.bak.<timestamp>`
- 幂等：重复跑只更新有变化的文件和自己的条目，不会重复注册；遇到冲突（用户已有非 claude-utils 的同槽位配置）会打印警告并跳过，不覆盖；`CLAUDE_CODE_PLUGIN_DIRS` 已有别的目录时追加，不覆盖

## 组件

### hooks/worktree-create.sh — `WorktreeCreate`

按前缀自动选 base branch 并注入日期戳：

| 输入 name | 实际 branch | base |
|---|---|---|
| `feat/<rest>` | `feat/YYMMDD-<rest>` | `origin/develop` |
| `feature/<rest>` | `feature/YYMMDD-<rest>` | `origin/develop` |
| `hotfix/<rest>` | `hotfix/YYMMDD-<rest>` | `origin/master` |
| 其他 | `worktree-<name>` | `origin/HEAD`（fallback） |

示例：`claude -w feat/kill-mutants-s2` → branch `feat/260418-kill-mutants-s2`，worktree 路径 `<repo>/.claude/worktrees/feat/260418-kill-mutants-s2/`。Base 不存在时自动回退到 `origin/HEAD`，保证脚本在不走 git-flow 的项目里也能用。

Local scope 的 MCP server 会跟到 worktree：local scope（`claude mcp add` 的默认 scope）在 `~/.claude.json` 里按目录绑定，worktree 本来一个都没有。hook 把父仓 `projects["<repo>"].mcpServers` 复制进 worktree 的 `.mcp.json`（已有的未跟踪 `.mcp.json` 做合并；已入仓的 `.mcp.json` 不动），并用 `info/exclude` 隐藏。Project scope 的 server 每个目录（即每个 worktree）要批准一次 —— 想免批准，把信任的 server 名字写进 `~/.claude/settings.json` 的 `enabledMcpjsonServers`。

### hooks/worktree-remove.sh — `WorktreeRemove`

配对清理。`git worktree remove`（**不带 `--force`**，dirty worktree 会保留）+ `git branch -D`（**仅当分支 tip 已合并进 `develop` / `master` / `main` 或存在于任一 remote ref**，否则保留分支）+ 清理空父目录。没 merge 也没 push 的分支不删 —— `branch -D` 是强制删除，删掉只存在这条分支上的 commit 就找不回来了。下次再 `claude -w <同名>` 时 create hook 的 reuse 路径会自动把 worktree 重新挂回这条分支。CC 调用此 hook 时 cwd 就是被删的 worktree 本身，所以脚本内部所有 git 写操作都通过 `git -C "$MAIN_REPO"` 从主 repo 上下文执行。

### mods/statusband — 输入框上方的状态横栏

一个 Claude Code mod（函数 hooks 插件），在输入框上方画一条 `AbovePrompt` 横栏，CLI 和桌面 app 通用，按 surface 各画各的：

- **CLI**：两行，内容对齐原来的 statusline.sh —— `[模型 v版本↑] 📁 目录 | 🔀 分支 | N files +a -d | 💾 命中率 ⏳缓存到期 | $会话/$今日/$本月`；第二行上下文、5h、7d 三条进度条（7d 上 `┃` 标出 Fable 周用量）。进度条用 `Raster` 画：实心底轨、同色系浅色的"已过时间"段、1/8 宽方块收尾，10 格分辨 80 级。按横栏宽度排版不折行，窄时先丢细节（今日/本月、diff、倒计时……），进度条始终保留。
- **桌面 app**：只显示 app 自己没有的那部分（目录、git、缓存命中率 + 到期、费用、5h/7d），Svg 进度条 + 线条图标；目录名后的 `↗` 点击用 Finder 打开。

配色阈值、7d 工作时段节奏都和原 statusline 一致；工作时段读 `STATUSLINE_WORK_START` / `STATUSLINE_WORK_END`（默认 9–22），建议写在 `settings.json` 的 `env` 里 —— 桌面 app 不读 shell 的 rc 文件。**按账号的数据（5h/7d、Fable）一律取当前 session 自己的账号**（`$.session.usage()`、`$.session.authorize()` + `$.http.fetch`），不读钥匙串 —— CLI 和 app 可以登录不同账号。今日/本月费用来自 ccusage，统计的是本机所有 JSONL（即两个账号合计），通过 `statusline-refresh-caches.sh ccusage` 刷新缓存。

改完跑 `claude plugin validate mods/statusband` 和 `claude plugin test mods/statusband`（terminal / desktop 两种 surface 的渲染测试）。

### statusline/statusline.sh — 双行状态栏（已退役，备用）

被上面的 statusband mod 取代；`install.sh --statusline` 仍可安装（连同配套的 `hooks/last-reply.sh` Stop hook，给 `⏱` 段记上次回复时间）。慢数据（ccusage 费用、Fable 用量）的刷新抽在 `statusline/statusline-refresh-caches.sh`，mod 也复用其中 ccusage 部分。详见 [`statusline/README.md`](statusline/README.md)。

## 架构

| 位置 | 角色 |
|---|---|
| 本仓库 | **源码**；`install.sh` 从这里拷贝出运行时 |
| `~/.claude/hooks/`、`~/.claude/mods/statusband/`、`~/.claude/statusline-refresh-caches.sh` | **运行时**（`install.sh` 拷贝出来的），`settings.json` 引用的是这些 |
| `~/.claude/settings.json` | CC 的配置，由 `install.sh` 幂等合并（hooks、`env.CLAUDE_CODE_PLUGIN_DIRS`） |
| `~/.claude/ccusage-cache.json` | 今日/本月费用缓存，mod 和旧 statusline 共用 |
| `~/.claude/worktree-hook.log` | worktree 两个 hook 的 stdin JSON 日志，排查问题用 |

```
claude-utils/
├── hooks/
│   ├── worktree-create.sh
│   ├── worktree-remove.sh
│   ├── worktree-lib.sh
│   ├── guard-worktree-edits.sh
│   └── last-reply.sh           # 旧 statusline 配套（备用）
├── mods/
│   └── statusband/             # 状态横栏 mod（hooks/register.tsx、types/、tests/）
├── statusline/
│   ├── statusline.sh           # 已退役，备用
│   ├── statusline-refresh-caches.sh
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

写 mod 时：

- **CLI 和 app 可以是两个账号**：钥匙串里的 token、`~/.claude.json` 都是 CLI 账号的。按账号的数据要用 session 自己的凭据（`$.session.authorize()` 给的 handle 交给 `$.http.fetch`），否则 app 里会显示 CLI 账号的数
- **mods 有灰度开关**（`tengu_plugin_hooks_modules`），缓存在 `~/.claude.json`，只在 CLI 联网启动时刷新；`claude plugin test` 报 "hooks modules are turned off" 时，先正常启动一次 `claude` 再试
- **desktop 上的 `Svg` 别加 `isInteractive`**：会被放进带白底的 iframe、默认 300×150，尺寸也要显式给 `width` / `height`
- **desktop 上只有 `Button` 能点**（`Svg`、`Box` 都不接点击），而且一律画成原生按钮
- **横栏和输入框之间那一行空白是引擎自己留的**，mod 控制不了

## Roadmap

- [x] `install.sh` + paste-prompt 一键装
- [ ] `uninstall.sh` / `install.sh --update`
- [ ] shellcheck + shfmt CI
- [ ] 英文 README

PR / issue welcome。

## License

MIT，见 [LICENSE](LICENSE)。
