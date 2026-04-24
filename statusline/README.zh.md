# Claude Code 自定义状态栏

自定义的 Claude Code 终端状态栏脚本，双行布局，实时显示工作环境和会话状态。

[English version](README.md)

## 效果预览

<p align="center">
  <img src="../docs/images/statusline.png" alt="双行状态栏效果 —— 第一行展示模型、目录、分支与 diff、token 吞吐、费用；第二行展示上下文窗口 + 5h/7d 速率限制进度条（叠加时间进度标记）" width="820" />
</p>

## 布局说明

### 第一行 — 工作环境

| 字段 | 说明 |
|------|------|
| `[Opus 4.6 (1M context)]` | 当前模型 |
| `📁 project` | 项目目录名 |
| `🔀 master` | Git 分支 |
| `3 files +25 -10` | 未提交的文件变更（`git diff --shortstat HEAD`） |
| `💾 95%` | **最近一轮** API 调用的 prompt 缓存命中率 |
| `$3.42 / $54.3 / $3.2K` | 会话费用 **/** 今日花销 **/** 本月累计。session 字段来自 stdin 实时值；今日与本月由 [`ccusage`](https://github.com/ryoppippi/ccusage) 提供（可选 —— 未安装则显示 `--`）。紧凑美元格式：`$X.XX` < 10，`$XX.X` < 100，`$XXX` < 1000，`$X.XK` ≥ 1000。 |
| `4h10m / 1d2h` | 累计 API 等待时间 **/** 墙钟时间。紧凑时长格式：`<24h` → `XhYm`，`≥24h` → `XdYh`（分钟精度；`5h`/`7d` 倒计时也走同一套格式化）。 |

### 第二行 — 配额状态

| 字段 | 说明 |
|------|------|
| `████░░░░ 35% (70k/200k)` | 上下文窗口用量（20 字符宽） |
| `5h ██░│░░░ 27% (3h12m)` | 5 小时滚动窗口用量（10 字符宽） |
| `7d ████░│░░░░░░ 30% (5d8h)` | 7 天窗口用量（14 字符宽） |
| `⏱ 14:32` | 当前会话里 CC 上次回复的时间（挂钟 `HH:MM`）。由 `Stop` hook `hooks/last-reply.sh` 提供；hook 至少触发过一次之前整段不显示。 |

## 核心特性

### 速率限制进度条 + 时间标记

5h 和 7d 进度条上叠加了一条时间进度标记 `│`，可以直观判断消耗速率是否可持续：

```
用量 < 时间进度 → 绿色（可持续）
  5h ██│░░░░░░░ 27%

用量 > 时间进度 → 黄色/橙色（偏快）
  5h █████│░░░░ 60%

用量 >= 90% → 红色（高位警告）
  5h █████████│ 95%
```

颜色逻辑：
- **绿色** — 用量 <= 时间进度，消耗可持续
- **黄色** — 用量略超时间进度，或用量 < 50%（低位保护，防止窗口初期误报）
- **橙色** — 用量 > 时间进度 × 1.5
- **红色** — 用量 >= 90%（绝对高位）

### Prompt 缓存命中率

`💾 XX%` 显示**最近一次** API 调用里，多少比例的 input token 是从 prompt cache 读的：

```
命中率 = cache_read_input_tokens / (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
```

三个字段都在 `context_window.current_usage` 下。该对象在 session 首次 API 调用之前为 `null`，此时显示 `💾 --`。

由于 stdin 只给了 `current_usage`（没有累计缓存字段），这个百分比只反映**一轮**，不是会话累计。单轮偏低不用惊慌 —— **连续几轮偏低**才是信号。

阈值（按实际观测到的 CC 稳态校准；**Anthropic 官方不发布目标值**，只建议你按自己的 workload 监控）：

| 命中率 | 颜色 | 解读 |
|---|---|---|
| ≥ 95% | 🟢 绿 | 健康稳态（CC 长会话典型值） |
| 80–95% | 🟡 黄 | 正常波动 —— 本轮接收了大块新内容（读文件 / 大 tool 输出） |
| 50–80% | 🟠 橙 | 系统性在打 cache |
| < 50% | 🔴 红 | 首轮 / 刚 `/clear` / 空闲 >5min / cache 真的坏了 |

会打破 cache 的常见操作：session 中途改 `CLAUDE.md` / `settings.json` / hooks、装/卸 MCP server、切 model 或 permission mode、频繁 `/clear`、大量派 sub-agent（每个都是冷启动）、空闲超过 5 分钟（Anthropic 默认缓存 TTL）。

### 7d 活跃时间计算

7d 窗口的时间标记不按自然时间（168h）计算，而是只计算**工作时段**内的活跃时间：

- 默认工作时段：09:00 - 22:00（每天 13 小时）
- 7 天总活跃时间 ≈ 91 小时
- 精确到分钟级：逐日历日计算工作时段与窗口的重叠

这样时间标记更准确地反映了"在正常使用节奏下你应该消耗多少"。

### 非工作时间提醒

当前时间在工作时段外（默认 22:00-09:00）时，5h 和 7d 的**进度条和百分比强制显示红色**，提醒你正在非常规时段使用。

### 上次回复时间戳

第二行末尾的 `⏱ HH:MM` 显示**当前会话里 CC 最近一次回复完的时间** —— 挂钟时间，不管是 30 秒前还是 30 小时前回的都是这一种格式。由 `Stop` hook [`hooks/last-reply.sh`](../hooks/last-reply.sh) 每次回复后往 `~/.claude/session-meta/<session_id>/last-reply.json` 写时间戳驱动；hook 至少触发过一次之前这一段不显示。

**为什么只给绝对时间、不给 `Xh ago`** —— statusline 只在交互时重绘，而每次重绘总是发生在 reply 完的几秒之内。任何基于"距今多久"的字段都是在那一瞬算好的，然后就冻在屏幕上陪你度过整段空闲 —— 你最需要它准的那一刻，它恰好在骗你。挂钟 `HH:MM` 相反，不管你过多久回来看都还是真的；跟手表一对心算一秒。

超过 24h 之后，光靠 `HH:MM` 已经分不出是哪天。没关系 —— 这种情况下你多半也不想继续原来的会话了，"哪天"早已不重要，"是不是还诚实"更关键。粗糙但真实胜过精致但骗人。

使用场景：合上电脑走人，几小时后回来扫一眼状态栏，不用翻对话就知道上次停在哪。per-session 设计，并发多个会话各显示各的；hook 还会顺手清掉空闲 30 天以上的 session 目录，不会无限膨胀。

### 今日 / 本月累计花销

第一行的费用字段从单个 session 数字扩展为 `$session / $today / $month`，让你同时看到三个真正决定使用决策的时间尺度："这一条回复多贵"、"今天已经花了多少"、"这个月走到哪一步了"。

- **Session**（`$3.42`，黄色）—— 每次渲染直接读 stdin 的 `cost.total_cost_usd`，< $10 时保留两位小数。
- **今日 / 本月**（`$54.3 / $3.2K`，淡色）—— 由 [`ccusage`](https://github.com/ryoppippi/ccusage) 扫描 `~/.claude/projects/*/*.jsonl` 按 token 乘以当前模型单价计算，数值与 `ccusage daily` / `ccusage monthly` 一致。如果 `PATH` 或 `~/.bun/bin/` 下都找不到 `ccusage`，这两格降级为 `--`，不影响其他字段。
- **缓存模型** —— 每次渲染只读 `~/.claude/ccusage-cache.json`（很便宜）。缓存超过 `STATUSLINE_CCUSAGE_TTL`（默认 600s）时，后台启一个子 shell 跑 `ccusage` 刷新缓存后退出（原子 rename 写入），**渲染本身永远不阻塞**。并发刷新用 `~/.claude/ccusage-cache.lock` 目录（`mkdir` 原子性）防雪崩，>60s 的死锁自清理。
- **时区** —— 今日和本月的分桶按 `STATUSLINE_CCUSAGE_TZ`（默认 = `/etc/localtime` 指向的系统时区）。比如上海跨日到 00:00，下次刷新时"今日"会自动归零，不受 JSONL 记录的时间戳影响。

代价：每个 TTL 窗口多跑一次 `ccusage` 子进程。其他全是 `jq` + `awk` 对缓存 JSON 操作，每次渲染开销 < 1ms。

## 安装

### 前置依赖

- bash
- jq
- git（可选，用于显示分支和文件变更）
- [`ccusage`](https://github.com/ryoppippi/ccusage)（可选，用于显示今日 / 本月累计花销 —— `bun add -g ccusage` 或 `npm install -g ccusage`；不装则这两格显示 `--`）
- macOS（`date -j -f` 用于时间计算）

### 配置

1. 复制脚本到 Claude Code 配置目录：

```bash
cp statusline.sh ~/.claude/statusline-command.sh
```

2. 在 `~/.claude/settings.json` 中配置状态栏：

```json
{
  "statusline": {
    "command": "bash ~/.claude/statusline-command.sh"
  }
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `STATUSLINE_WORK_START` | `9` | 工作时段开始（小时，0-23） |
| `STATUSLINE_WORK_END` | `22` | 工作时段结束（小时，0-23） |
| `STATUSLINE_CCUSAGE_TTL` | `600` | 今日 / 本月花销后台刷新间隔（秒） |
| `STATUSLINE_CCUSAGE_TZ` | 系统时区（读 `/etc/localtime`） | 今日 / 本月分桶使用的 IANA 时区（如 `Asia/Shanghai`），与 `ccusage --timezone` 保持一致 |

示例：调整为 8:00-21:00 工作时段：

```bash
export STATUSLINE_WORK_START=8
export STATUSLINE_WORK_END=21
```

## 数据来源

大部分字段来自 Claude Code 通过 stdin 传入的 JSON。例外：

- **今日 / 本月累计花销** —— 由 `ccusage` 扫描 `~/.claude/projects/*/*.jsonl` 而来（见上文[今日 / 本月累计花销](#今日--本月累计花销)）。
- **上次回复时间戳** —— 从 `~/.claude/session-meta/<session_id>/last-reply.json` 读取，文件由 `Stop` hook [`hooks/last-reply.sh`](../hooks/last-reply.sh) 每次回复后写入（见上文[上次回复时间戳](#上次回复时间戳)）。

stdin 字段列表：

| JSON 路径 | 用途 |
|-----------|------|
| `model.display_name` | 模型名称 |
| `workspace.current_dir` | 当前目录 |
| `context_window.used_percentage` | 上下文用量 |
| `context_window.context_window_size` | 上下文窗口大小 |
| `context_window.total_input_tokens` | 累计输入 token（默认不展示，在 `statusline.sh` 里取消注释 `↑${SEND_FMT} ↓${RECV_FMT}` 那行即可恢复） |
| `context_window.total_output_tokens` | 累计输出 token（同上） |
| `context_window.current_usage.input_tokens` | 最近一轮的非缓存输入（算缓存命中率用） |
| `context_window.current_usage.cache_creation_input_tokens` | 最近一轮写入缓存的 token |
| `context_window.current_usage.cache_read_input_tokens` | 最近一轮从缓存读的 token |
| `cost.total_cost_usd` | 会话费用（估算值；Pro/Max 订阅用户不代表实际账单） |
| `cost.total_api_duration_ms` | 本会话累计 API 等待时间 |
| `cost.total_duration_ms` | 会话墙钟时间 |
| `rate_limits.five_hour.*` | 5h 滚动窗口用量和重置时间 |
| `rate_limits.seven_day.*` | 7d 窗口用量和重置时间 |

> `rate_limits` 仅在 Claude.ai Pro/Max 订阅且首次 API 响应后可用。
