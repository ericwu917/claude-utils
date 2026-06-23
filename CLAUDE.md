# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库定位

这是用户 Claude Code 扩展的**源码 + 运行时仓库**，目前包含 `hooks/`（worktree 生命周期钩子）和 `statusline/`（自定义状态栏脚本），未来还会有 skills/agents。

**重要的模型变化**：v0.1.0 之后，`~/.claude/settings.json` 里的路径**直接指向本仓库的工作树**（通常克隆在 `~/.claude/claude-utils/`），不再 `cp` 到 `~/.claude/hooks/`。`git pull` 就是升级，不用重跑 install；只有 `settings.json` schema 变化时才需要再跑一次 `install.sh`。

安装入口：
```bash
./install.sh --all              # 幂等合并到 ~/.claude/settings.json（jq 驱动，写前备份）
./install.sh --dry-run          # 看 diff 不写
```

脚本行为要点：
- 依赖 `jq`；缺了会 exit 2 并指向 `docs/SETTINGS_MERGE.md`
- 写之前备份到 `~/.claude/settings.json.bak.<timestamp>`
- **冲突检测走 basename 匹配**：`hooks.WorktreeCreate[].hooks[].command` 以 `/worktree-create.sh` 结尾的被视为"我们的"，覆盖；其他一律判为冲突，跳过不动，提示用户看 `docs/SETTINGS_MERGE.md`
- `statusline.command` 冲突检测靠路径 substring `/statusline/statusline.sh`

改动立即生效性：hooks 需要重启 CC session 或 `/hooks` 重载；statusline 是每次渲染前拉起的子进程，改完立即生效。

## Hook 契约（非显而易见）

`hooks/` 下两个脚本通过 `settings.json` 挂到 CC 事件（`WorktreeCreate`、`WorktreeRemove`）。以下踩坑点是实测得来，官方文档没写 —— 改脚本时务必记住：

- **`WorktreeCreate` 的 stdin**：worktree name 字段在顶层 `.name`，**不是** `.tool_input.name`。脚本里用 `jq_first` 探测多个路径是为了抗未来字段变动，这个模式要保留。
- **`transcript_path` 空 = 桌面版自动创建**：CLI 里 `claude -w <name>` 总是带着真实 session 的 `transcript_path`；桌面版自动开 worktree 时还没有 transcript，发的 `.transcript_path` 是空串。这是区分"用户手敲的名字"和"桌面随机 slug"的唯一可靠信号（slug 形状本身不够，`fix-login` 也像 slug）。`is_desktop_auto_name` 就靠这个 + slug 形状两者并存来判定。
- **`WorktreeRemove` 的 stdin**：路径字段是 `.worktree_path`（snake_case），**不是** `.path` 或 `.worktreePath`。
- **`WorktreeRemove` 的 cwd 陷阱**：CC 调用此 hook 时，cwd 就是**即将被删的 worktree 本身**。在这个 cwd 直接跑 `git worktree remove` 或 `git branch -D` 会失败 —— git 拒绝自删 cwd，也拒绝删除当前 checked-out 的 branch。所有写操作必须通过 `git -C "$MAIN_REPO"` 执行，其中 `MAIN_REPO` 由 `git worktree list --porcelain` 的第一条记录解析得到。
- **必须成对配置**：一旦配了 `WorktreeCreate`，就**必须**同时配 `WorktreeRemove`。CC 的默认清理在 `/exit` 时不会跑 —— 即使是干净的 worktree 也不会被自动移除。这一点文档没写。
- **`WorktreeRemove` 不能阻断**：按文档其失败只会被记录，不会向上传播。永远 `exit 0`，错误往 stderr 写即可。
- **remove 不带 `--force`**：dirty worktree 要刻意保留（用户可能有未提交工作）。让 `git worktree remove` 失败并直接退出就行。

## `worktree-create.sh` 的命名约定

不只是外观 —— 前缀决定 base branch：

| 输入 `name` | Branch | Base | Worktree 目录 |
|---|---|---|---|
| `feat/<rest>` | `feat/<YYMMDD>-<rest>` | `origin/develop` | `feat/<YYMMDD>-<rest>/` |
| `hotfix/<rest>` | `hotfix/<YYMMDD>-<rest>` | `origin/master` | `hotfix/<YYMMDD>-<rest>/` |
| `<slug>`（desktop 自动名）| `claude/<YYMMDD>-<slug>` | `origin/HEAD` | `<YYMMDD>-<slug>/` |
| 其他 | `worktree-<name>` | `origin/HEAD`（fallback） | `<name>/` |

如果目标仓库没有约定的 base（例如没有 `origin/develop`），自动回退到 `origin/HEAD`，保证脚本在不使用 git-flow 的项目里也能用。

**desktop 自动名这一行**是为 Claude Code 桌面版准备的：桌面版创建 worktree 时不给输入 name 的机会，CC 直接发一个 docker 风格随机 slug（`sad-tharp-abb433`），没有 feat/hotfix 语义。识别条件是 **`transcript_path` 为空 + slug 形状（`词-词[-6位hex]`）两者同时成立**（判据见 `is_desktop_auto_name`）——只满足形状不够，因为你手敲的 `fix-login` 也长得像 slug，但它带着真实 session 的 `transcript_path`。命中后给它盖日期戳、挂在桌面自己的 `claude/` 前缀下（branch 带 `claude/` 前缀，目录是扁平的 `<YYMMDD>-<slug>`，不嵌套 `claude/` 子目录）。和 feat/hotfix 一样，跨天再进同一个 slug 会复用已有的 dated branch 而不是再盖一个新日期。

> **拿不到桌面的 "Branch prefix" 配置**：桌面设置里的 Branch prefix（默认 `claude/`）存在 app 内部状态里，不落在任何可读的 JSON（`settings.json` / `~/.claude.json` / `Application Support/Claude/*.json` / Local Storage 都没有），hook 读不到，所以这里的 `claude/` 是写死的、用来对齐桌面默认值。桌面的 `git-worktrees.json`（含 `branch` + `sourceBranch`）由桌面的 local-agent 路径写，那条路径**不触发本 hook**，跟 hook 路径完全不重叠，别指望从那里取值。

## 版本与 commit 约定

- **Commit message**：走 [Conventional Commits](https://www.conventionalcommits.org/)。常用前缀 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:`。破坏性变更在 footer 写 `BREAKING CHANGE:`，或前缀带 `!`（例 `feat(hooks)!:`）。
- **版本号**：整仓 SemVer，当前处于 `0.x`。`0.x` 期间允许破坏性改动（hook stdin 字段适配、`settings.json` schema 变化都算）。安装契约稳定后（有 `install.sh` 且稳定）再发 `1.0.0`。
- **打 tag 时机**：合入第二个功能或首次破坏性变更时打 `v0.1.0`，之后按 SemVer 节奏推进。
- **CHANGELOG.md**：每次打 tag 前同步更新；没打 tag 之前不强制维护。

## 调试

两个 hook 都会在做任何事之前，把原始 stdin JSON 追加到 `~/.claude/worktree-hook.log`。hook 出问题时先看这个日志 —— stdin payload 是 "CC 到底发了什么字段" 的唯一 ground truth。
