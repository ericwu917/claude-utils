# Claude Code 自定义状态栏

自定义的 Claude Code 终端状态栏脚本，双行布局，实时显示工作环境和会话状态。

## 效果预览

```
[Opus 4.6 (1M context)] 📁 project | 🔀 master | 3 files +25 -10 | ↑50k ↓20k | $0.50
████████░░░░░░░░░░░░ 35% (70k/200k) | 5h ██░░│░░░░░ 27% (3h12m) | 7d ████░░│░░░░░░░ 30% (5d8h)
```

## 布局说明

### 第一行 — 工作环境

| 字段 | 说明 |
|------|------|
| `[Opus 4.6 (1M context)]` | 当前模型 |
| `📁 project` | 项目目录名 |
| `🔀 master` | Git 分支 |
| `3 files +25 -10` | 未提交的文件变更（`git diff --shortstat HEAD`） |
| `↑50k ↓20k` | 本次会话累计输入/输出 token 数 |
| `$0.50` | 本次会话累计费用 |

### 第二行 — 配额状态

| 字段 | 说明 |
|------|------|
| `████░░░░ 35% (70k/200k)` | 上下文窗口用量（20 字符宽） |
| `5h ██░│░░░ 27% (3h12m)` | 5 小时滚动窗口用量（10 字符宽） |
| `7d ████░│░░░░░░ 30% (5d8h)` | 7 天窗口用量（14 字符宽） |

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

### 7d 活跃时间计算

7d 窗口的时间标记不按自然时间（168h）计算，而是只计算**工作时段**内的活跃时间：

- 默认工作时段：09:00 - 22:00（每天 13 小时）
- 7 天总活跃时间 ≈ 91 小时
- 精确到分钟级：逐日历日计算工作时段与窗口的重叠

这样时间标记更准确地反映了"在正常使用节奏下你应该消耗多少"。

### 非工作时间提醒

当前时间在工作时段外（默认 22:00-09:00）时，5h 和 7d 的**进度条和百分比强制显示红色**，提醒你正在非常规时段使用。

## 安装

### 前置依赖

- bash
- jq
- git（可选，用于显示分支和文件变更）
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

示例：调整为 8:00-21:00 工作时段：

```bash
export STATUSLINE_WORK_START=8
export STATUSLINE_WORK_END=21
```

## 数据来源

所有数据来自 Claude Code 通过 stdin 传入的 JSON，主要字段：

| JSON 路径 | 用途 |
|-----------|------|
| `model.display_name` | 模型名称 |
| `workspace.current_dir` | 当前目录 |
| `context_window.used_percentage` | 上下文用量 |
| `context_window.context_window_size` | 上下文窗口大小 |
| `context_window.total_input_tokens` | 累计输入 token |
| `context_window.total_output_tokens` | 累计输出 token |
| `cost.total_cost_usd` | 会话费用 |
| `rate_limits.five_hour.*` | 5h 滚动窗口用量和重置时间 |
| `rate_limits.seven_day.*` | 7d 窗口用量和重置时间 |

> `rate_limits` 仅在 Claude.ai Pro/Max 订阅且首次 API 响应后可用。
