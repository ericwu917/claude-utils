# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库定位

这是用户 Claude Code 扩展的**源码仓库**，目前包含 `hooks/`（worktree 生命周期钩子）和 `statusline/`（自定义状态栏脚本），未来还会有 skills/agents。CC 运行时并不从这里加载，而是从 `~/.claude/` 加载。因此任何改动都需要拷贝到 `~/.claude/` 才能生效：

```bash
cp hooks/*.sh ~/.claude/hooks/ && chmod +x ~/.claude/hooks/*.sh
cp statusline/statusline.sh ~/.claude/statusline-command.sh
```

目前没有 `install.sh`，安装靠手动 `cp`。`~/.claude/settings.json` 引用的是 `$HOME/.claude/...` 路径，绝不直接指向本工作树。拷贝完成后需重启 CC session 或跑 `/hooks` 重载（hooks 生效）；statusline 脚本是每次渲染前拉起的子进程，改完立即生效。

## Hook 契约（非显而易见）

`hooks/` 下两个脚本通过 `settings.json` 挂到 CC 事件（`WorktreeCreate`、`WorktreeRemove`）。以下踩坑点是实测得来，官方文档没写 —— 改脚本时务必记住：

- **`WorktreeCreate` 的 stdin**：worktree name 字段在顶层 `.name`，**不是** `.tool_input.name`。脚本里用 `jq_first` 探测多个路径是为了抗未来字段变动，这个模式要保留。
- **`WorktreeRemove` 的 stdin**：路径字段是 `.worktree_path`（snake_case），**不是** `.path` 或 `.worktreePath`。
- **`WorktreeRemove` 的 cwd 陷阱**：CC 调用此 hook 时，cwd 就是**即将被删的 worktree 本身**。在这个 cwd 直接跑 `git worktree remove` 或 `git branch -D` 会失败 —— git 拒绝自删 cwd，也拒绝删除当前 checked-out 的 branch。所有写操作必须通过 `git -C "$MAIN_REPO"` 执行，其中 `MAIN_REPO` 由 `git worktree list --porcelain` 的第一条记录解析得到。
- **必须成对配置**：一旦配了 `WorktreeCreate`，就**必须**同时配 `WorktreeRemove`。CC 的默认清理在 `/exit` 时不会跑 —— 即使是干净的 worktree 也不会被自动移除。这一点文档没写。
- **`WorktreeRemove` 不能阻断**：按文档其失败只会被记录，不会向上传播。永远 `exit 0`，错误往 stderr 写即可。
- **remove 不带 `--force`**：dirty worktree 要刻意保留（用户可能有未提交工作）。让 `git worktree remove` 失败并直接退出就行。

## `worktree-create.sh` 的命名约定

不只是外观 —— 前缀决定 base branch：

| 输入 `name` | Branch | Base |
|---|---|---|
| `feat/<rest>` | `feat/<YYMMDD>-<rest>` | `origin/develop` |
| `hotfix/<rest>` | `hotfix/<YYMMDD>-<rest>` | `origin/master` |
| 其他 | `worktree-<name>` | `origin/HEAD`（fallback） |

Worktree 落在 `<repo-root>/.claude/worktrees/<branch>/`。如果目标仓库没有约定的 base（例如没有 `origin/develop`），自动回退到 `origin/HEAD`，保证脚本在不使用 git-flow 的项目里也能用。

## 版本与 commit 约定

- **Commit message**：走 [Conventional Commits](https://www.conventionalcommits.org/)。常用前缀 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:`。破坏性变更在 footer 写 `BREAKING CHANGE:`，或前缀带 `!`（例 `feat(hooks)!:`）。
- **版本号**：整仓 SemVer，当前处于 `0.x`。`0.x` 期间允许破坏性改动（hook stdin 字段适配、`settings.json` schema 变化都算）。安装契约稳定后（有 `install.sh` 且稳定）再发 `1.0.0`。
- **打 tag 时机**：合入第二个功能或首次破坏性变更时打 `v0.1.0`，之后按 SemVer 节奏推进。
- **CHANGELOG.md**：每次打 tag 前同步更新；没打 tag 之前不强制维护。

## 调试

两个 hook 都会在做任何事之前，把原始 stdin JSON 追加到 `~/.claude/worktree-hook.log`。hook 出问题时先看这个日志 —— stdin payload 是 "CC 到底发了什么字段" 的唯一 ground truth。
