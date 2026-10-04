# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库定位

这是用户 Claude Code 扩展的**源码仓库**，目前包含 `hooks/`（worktree 生命周期钩子）、`mods/statusband/`（输入框上方的状态横栏 mod，CLI 和桌面 app 通用）和 `statusline/`（旧状态栏脚本，已被 mod 取代、留作备用），未来还会有 skills/agents。

**运行时是拷贝，不指向工作树**：`install.sh` 把运行时拷到 `~/.claude/`（`hooks/*.sh`、`mods/statusband/`、`statusline-refresh-caches.sh`；旧 statusline 是 `statusline-command.sh`），`settings.json` 引用的是拷贝。这样仓库切分支、改到一半都不会弄坏正在跑的 session。改完代码要重跑 `install.sh` 才进运行时。

安装入口：
```bash
./install.sh --all              # 默认 = --hooks + --mods；幂等合并到 ~/.claude/settings.json（jq 驱动，写前备份）
./install.sh --statusline       # 旧 statusline.sh（备用），连同 last-reply.sh Stop hook
./install.sh --dry-run          # 只报会拷什么、看 settings diff，不写
```

脚本行为要点：
- 依赖 `jq`；缺了会 exit 2 并指向 `docs/SETTINGS_MERGE.md`
- 写之前备份到 `~/.claude/settings.json.bak.<timestamp>`；拷贝逐个报 `new` / `updated` / `unchanged`
- **冲突检测走 basename 匹配**：`hooks.WorktreeCreate[].hooks[].command` 以 `/worktree-create.sh` 结尾的被视为"我们的"，覆盖；其他一律判为冲突，跳过不动，提示用户看 `docs/SETTINGS_MERGE.md`
- `env.CLAUDE_CODE_PLUGIN_DIRS` 是 `:` 分隔列表：保留别人的目录，以 `/mods/statusband` 结尾的视为我们的，去重后追加
- `statusLine.command` 冲突检测靠 substring `statusline-command.sh` 或 `/statusline/statusline.sh`（键是 `statusLine` + `type: command`；旧版脚本写成小写 `statusline`，从来没生效过）

改动立即生效性：hooks 需要重启 CC session 或 `/hooks` 重载；mod 在 session 启动时加载（开发时用 dev-mods 热重载，见下）。

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
| `feature/<rest>` | `feature/<YYMMDD>-<rest>` | `origin/develop` | `feature/<YYMMDD>-<rest>/` |
| `hotfix/<rest>` | `hotfix/<YYMMDD>-<rest>` | `origin/master` | `hotfix/<YYMMDD>-<rest>/` |
| `<slug>`（desktop 自动名）| `claude/<YYMMDD>-<slug>` | `origin/HEAD` | `<YYMMDD>-<slug>/` |
| 其他 | `worktree-<name>` | `origin/HEAD`（fallback） | `<name>/` |

如果目标仓库没有约定的 base（例如没有 `origin/develop`），自动回退到 `origin/HEAD`，保证脚本在不使用 git-flow 的项目里也能用。

**desktop 自动名这一行**是为 Claude Code 桌面版准备的：桌面版创建 worktree 时不给输入 name 的机会，CC 直接发一个 docker 风格随机 slug（`sad-tharp-abb433`），没有 feat/hotfix 语义。识别条件是 **`transcript_path` 为空 + slug 形状（`词-词[-6位hex]`）两者同时成立**（判据见 `is_desktop_auto_name`）——只满足形状不够，因为你手敲的 `fix-login` 也长得像 slug，但它带着真实 session 的 `transcript_path`。命中后给它盖日期戳、挂在桌面自己的 `claude/` 前缀下（branch 带 `claude/` 前缀，目录是扁平的 `<YYMMDD>-<slug>`，不嵌套 `claude/` 子目录）。和 feat/hotfix 一样，跨天再进同一个 slug 会复用已有的 dated branch 而不是再盖一个新日期。

> **拿不到桌面的 "Branch prefix" 配置**：桌面设置里的 Branch prefix（默认 `claude/`）存在 app 内部状态里，不落在任何可读的 JSON（`settings.json` / `~/.claude.json` / `Application Support/Claude/*.json` / Local Storage 都没有），hook 读不到，所以这里的 `claude/` 是写死的、用来对齐桌面默认值。桌面的 `git-worktrees.json`（含 `branch` + `sourceBranch`）由桌面的 local-agent 路径写，那条路径**不触发本 hook**，跟 hook 路径完全不重叠，别指望从那里取值。

## `guard-worktree-edits.sh`（PreToolUse 编辑越界守卫）

挂在 `PreToolUse`（matcher `Edit|Write|MultiEdit|NotebookEdit`），把文件编辑**锁在当前 worktree/repo 根内**：目标落在根外就返回 `permissionDecision: ask`，让 CC 弹确认，而不是 auto mode 静默放行。治的是"人在 worktree 里、却误改父 repo 文件"这类 bleed —— prose 警告（在 CLAUDE.md 里写一条）拦不住 LLM 的路径混淆，auto-mode classifier 也只看信任边界、不看"worktree vs 主 repo"，只有确定性 hook 才拦得住。

**锚点**：`git -C "$cwd" rev-parse --show-toplevel`。在 worktree 里它返回 worktree 自己，所以嵌套布局 `<主repo>/.claude/worktrees/<branch>/` 反而帮忙 —— 父 repo 文件在这个根**之上**，自然落在 prefix 外。

**为什么保留嵌套布局、没把 worktree 挪到 repo 外**（实测结论，反直觉，务必记住）：CC 发现项目级 skill/agent/command 是"从 cwd 沿父目录向上走到 repo 根为止"的**文件系统遍历**（官方文档），settings 不向上合并。所以 worktree 能用到的项目 `.claude/` 配置 = 它自己 checkout 出来的（tracked 的）+ **沿祖先目录找到的主 repo 的（untracked 的）**。本仓库作者**绝大多数项目的 `.claude/` 不 track** —— 这些 untracked skill/agent 只有在 worktree **嵌套在主 repo 内**（主 repo 是其文件系统祖先）时才被加载；一旦把 worktree 挪到 repo 外（sibling），主 repo 不再是祖先，这些 untracked 配置全部失效。**所以嵌套是有意保留的，guard 是配套兜底**，不是退而求其次。

**判定模型**：**主 repo 也只是一棵 tree**。任何 session 只能改自己 tree 根下的文件，跨 tree 一律 ask —— **双向**：worktree → 父 repo 仓内文件要弹，主 repo → 任意 worktree 的文件同样要弹。实现上就是 `in-root` 放行时把本根自己的 `.claude/worktrees/`（那底下是别的 tree）挖掉。

**白名单（放行不弹）**：当前 tree 根内（除去本根的 `.claude/worktrees/`）、临时目录（`$TMPDIR`/`/tmp`/scratchpad）、`~/.claude`、主 repo 的 `.claude/`（同样除去 `.claude/worktrees/`）。

> **"主 repo" 必须从路径切、不能问 git**（踩过的坑）：`<主repo>` 取自 `ROOT` 里 `/.claude/worktrees/` 左边那一截，因为需求要的是"CC 沿文件系统祖先加载 skill/agent 的那个目录"。别用 `git worktree list` 第一条 —— 它回答的是另一个问题（git 心目中的主工作树），算法是 common gitdir 的 realpath 去掉结尾 `/.git`；仓库若以 `--separate-git-dir` 建立（`.git` 是文件、gitdir 另有其名），它报出的是 gitdir 本身，白名单永远匹配不上，主 repo 的 `.claude/skills` 会一直弹。也别改用 `rev-parse --show-toplevel`：在 worktree 里它返回 worktree 自己，白名单会退化成死代码。根本原因是**从 linked worktree 内部，git 没有任何指回主工作树的记录**，这个信息只存在于路径里。`git worktree list` 仅作非约定布局的兜底。

**契约要点**：
- stdout 只能是空（allow）或单个 JSON（ask）；所有诊断写 `$LOG`，绝不写 stdout，否则 CC 解析不了。
- 不用 `set -e`、永远 `exit 0`：任何内部出错都 fail-open（放行），绝不卡死用户编辑。
- 单次 jq 抽字段；worktree 内编辑（常见情况）只付一次 `git rev-parse`，`git worktree list` 只在非约定布局的兜底分支才调。
- `DEBUG`：`1` 记每次调用（params + 判定，验证用）但**跳过 `in-root`** —— 那是绝大多数真实流量、没有信息量，记了会淹掉日志；`0` 只记 ask。日志在 `~/.claude/worktree-guard.log`（独立于 `worktree-hook.log`）。

## `mods/statusband`（状态横栏 mod）

一个 hooks 模块插件（`hooks/register.tsx` 导出 `register(on)`），画 `AbovePrompt` 横栏；`ui.render` 里按 `e.surface` 分两支：terminal 画 statusline.sh 的两行（emoji、`|`、`Raster` 进度条），desktop 只画 app 自己没有的子集（`Svg` 进度条、线条图标）。其他 surface `next(e)`。状态全放 `$.state`（`types/index.d.ts` 是契约），热重载不丢。

数据从哪来（非显而易见）：
- 5h/7d、会话费用、上下文：`$.session.usage()` + `session.measure` 推送，**是当前 session 自己账号的**
- 缓存命中率：主线程 `turn.step` 的 `usage`（`e.agentId` 为空才算，排除子 agent）——对应 statusline 的 `current_usage`
- ⏳ 缓存到期：读 transcript 尾部（`~/.claude/projects/<root 非字母数字→->/<session id>.jsonl`），因为 `turn.step` 的 usage 没有 5m/1h 拆分、idle recap 也不触发 step。算法和 statusline.sh 的 jq 一致
- Fable：`$.session.authorize()` 拿 handle → `$.http.fetch('https://api.anthropic.com/api/oauth/usage', { auth })`，token 不经过 mod。匹配规则和 `statusline-refresh-caches.sh` 的 `FABLE_DEF` 保持一致
- 今日/本月：读 `~/.claude/ccusage-cache.json`，过期调 `~/.claude/statusline-refresh-caches.sh ccusage`（本机所有 JSONL = 所有账号合计）

**踩过的坑**：
- **CLI 和 app 是两个账号**（用户的 CLI 是有 Fable 的 Max 账号）。钥匙串 `Claude Code-credentials`、`~/.claude.json` 都是 CLI 账号的——按账号的数据绝不能走钥匙串，否则 app 里显示 CLI 的数
- **mods 有灰度开关** `tengu_plugin_hooks_modules`，缓存在 `~/.claude.json`（CLI 账号的），只在 CLI 联网启动时刷新；`claude plugin test` 报 "hooks modules are turned off" 不一定是真没开，先启动一次 `claude`
- desktop `Svg` 加 `isInteractive` 会进带白底的 iframe（默认 300×150）；要显式给 `width`/`height`
- desktop 上只有 `Button` 接点击（`Svg`/`Box` 不行），且一律画原生按钮
- terminal 上 `Link` 只收 `https:`；要 statusline 那种 `file://` 链接（cmd+点击开 Finder）得用 `Markdown`（`[name](file:///…)`，它收 `file:`），加 `onLinkPress` 后普通单击也会落到 mod。实测在一行里排版正常
- terminal 横栏按 `e.props.bodyColumns` 手工排版（`fitLine`：按 `drop` 优先级丢段，不用 `flexWrap`），保证两行、窄时丢细节不丢进度条
- `Raster` 一格只有一个字形 + 前景/背景：Fable `┃` 落在填充里时要画在填充色上（深色），否则会在填充中间挖出缺口，和旁边的 1/8 块拼成 `||`
- 横栏和输入框之间那一行空白是引擎留的，mod 改不了

**测试**（`tests/render.test.tsx`，`claude plugin test mods/statusband`）：测试环境没有 fs/process/clock——必须 `mock.clock(on, …)`，否则 render 钩子被跳过；测试的 `$` 没有 `state`，要用 `on('state.get', …)` 在插件下层喂数据，而且返回值要包一层：`{ value: { value, version } }`。

**开发流程**：在 session 里加载 `plugin-authoring` skill，把 mod 放进它给的 dev-mods 目录即可热重载；定稿后改仓库这份，再 `install.sh --mods` 进运行时。改完跑 `claude plugin validate` + `claude plugin test`。

## 版本与 commit 约定

- **Commit message**：走 [Conventional Commits](https://www.conventionalcommits.org/)。常用前缀 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:`。破坏性变更在 footer 写 `BREAKING CHANGE:`，或前缀带 `!`（例 `feat(hooks)!:`）。
- **版本号**：整仓 SemVer，当前处于 `0.x`。`0.x` 期间允许破坏性改动（hook stdin 字段适配、`settings.json` schema 变化都算）。安装契约稳定后（有 `install.sh` 且稳定）再发 `1.0.0`。
- **打 tag 时机**：合入第二个功能或首次破坏性变更时打 `v0.1.0`，之后按 SemVer 节奏推进。
- **CHANGELOG.md**：每次打 tag 前同步更新；没打 tag 之前不强制维护。

## 调试

两个 hook 都会在做任何事之前，把原始 stdin JSON 追加到 `~/.claude/worktree-hook.log`。hook 出问题时先看这个日志 —— stdin payload 是 "CC 到底发了什么字段" 的唯一 ground truth。

statusband 的失败（Fable 请求等）写 debug log（`claude --debug`），行首 `statusband:`；钩子被跳过、树校验不过时，热重载的 session 会在 transcript 里出一行灰字。
