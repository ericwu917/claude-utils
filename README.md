# claude-utils

个人 Claude Code 扩展积累：hooks、skills、agents 等，统一在此仓库迭代，通过"安装"拷贝到 `~/.claude/` 供 CC 运行时加载。

## 架构

| 位置 | 角色 |
|---|---|
| `claude-utils/` (本仓库) | **源码**：编辑、版本管理都在这里 |
| `~/.claude/` | **安装目录**：CC 启动时实际加载的位置 |
| `~/.claude/settings.json` | 引用 `$HOME/.claude/...` 路径，不直接指向源码工作树 |

**安装方式**：目前手动 `cp`，后续加 `install.sh` 封装。

## 目录结构

```
claude-utils/
├── hooks/                      # Claude Code hooks (Pre/Post/Worktree* 等事件)
│   ├── worktree-create.sh
│   └── worktree-remove.sh
├── statusline/                 # 自定义状态栏脚本
│   ├── statusline.sh
│   └── README.md
└── README.md
```

未来会陆续加入：
- `skills/` — 自定义 skills
- `agents/` — 自定义 sub-agents
- `install.sh` — 统一安装入口

## 当前内容

### hooks/worktree-create.sh — `WorktreeCreate` hook

接管 CC 默认的 `git worktree add` 逻辑，按命名约定自动选 base branch 并注入日期戳：

| 输入 name | 实际 branch | base |
|---|---|---|
| `feat/<rest>` | `feat/YYMMDD-<rest>` | `origin/develop` |
| `hotfix/<rest>` | `hotfix/YYMMDD-<rest>` | `origin/master` |
| 其他 | `worktree-<name>` | `origin/HEAD`（fallback） |

示例：`claude -w feat/kill-mutants-s2` → branch `feat/260418-kill-mutants-s2`，worktree 路径 `.claude/worktrees/feat/260418-kill-mutants-s2/`。

Hook 流程：
1. 从 stdin 解析 `.name`（多路径探测兼容未来字段变化）
2. 前缀匹配 → 决定 base
3. `git fetch origin`
4. `git worktree add -b <branch> <path> <base>`
5. stdout 打印绝对路径（CC 据此 chdir 进去）

### hooks/worktree-remove.sh — `WorktreeRemove` hook

配对清理逻辑。配 `WorktreeCreate` 后必须配 `WorktreeRemove`，否则 CC 的默认清理在 `/exit` 时不会触发（实测确认）。

行为：
1. 从 stdin 解析 `.worktree_path`（CC 实际字段，snake_case）
2. 注意 CC 调用时 cwd 就是被删的 worktree 本身 → 所有 git 写操作必须通过 `git -C "$MAIN_REPO"` 从主 repo 上下文执行
3. `git worktree remove <path>`（**不带 `--force`**：dirty worktree 保留）
4. `git branch -D <branch>`
5. `rmdir` 空的父目录（只在严格子孙于 `.claude/worktrees/` 时，用 `rmdir` 保证非空不删）

### statusline/statusline.sh — 自定义状态栏

双行终端状态栏：第一行工作环境（模型、目录、git 分支、diff、token、费用），第二行配额（上下文窗口 + 5h/7d 速率限制进度条，叠加时间进度标记）。详见 `statusline/README.md`。

安装：

```bash
cp statusline/statusline.sh ~/.claude/statusline-command.sh
```

并在 `~/.claude/settings.json` 配置 `statusline.command` 指向它。

### Hook 日志

两个 hook 都把 stdin JSON 追加到 `~/.claude/worktree-hook.log`，排查问题时先看这个。

## 安装（当前）

```bash
cp hooks/*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
```

并在 `~/.claude/settings.json` 加：

```json
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.claude/hooks/worktree-create.sh\"", "timeout": 120 } ] }
    ],
    "WorktreeRemove": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.claude/hooks/worktree-remove.sh\"", "timeout": 60 } ] }
    ]
  }
}
```

重启 Claude Code session（或 `/hooks` 重载）后生效。

## 相关踩坑记录（写 hook 时值得记住）

- **Create hook 的 stdin**：`name` 字段在顶层，不在 `tool_input.name`
- **Remove hook 的 stdin**：`worktree_path`（snake_case），不是 `.path` / `.worktreePath`
- **Remove hook 的 cwd 陷阱**：CC 从被删 worktree 内部调用，直接跑 git 会尝试自删 cwd / 自删 checked-out branch，都会被 git 硬拦
- **WorktreeCreate 不配 WorktreeRemove 的后果**：CC 默认清理不会跑，干净 worktree 也不会自动删（官方文档未明说，实测确认）
