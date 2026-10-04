# settings.json 手动合并指南

`install.sh` 在两种情况下会退出并要求人工介入：

1. **jq 未安装** —— 合并需要 jq，自动流程无法继续
2. **检测到冲突** —— `~/.claude/settings.json` 里某个槽位（`WorktreeCreate` / `WorktreeRemove` / `PreToolUse`，或旧 statusline 的 `statusLine` / `Stop`）已经有了非 claude-utils 的配置，脚本不敢覆盖

本文档告诉你要插入什么、或者如何把这份文档喂给 Claude 让它帮你改。

[English version](SETTINGS_MERGE.md)

## 运行时文件

`install.sh` 是把运行时**拷贝**到 `~/.claude/`（从不让 `settings.json` 指向仓库）。手动合并的话，先在仓库根目录拷这些：

```bash
mkdir -p ~/.claude/hooks ~/.claude/mods
cp hooks/worktree-create.sh hooks/worktree-remove.sh hooks/worktree-lib.sh hooks/guard-worktree-edits.sh ~/.claude/hooks/
cp -R mods/statusband ~/.claude/mods/
cp statusline/statusline-refresh-caches.sh ~/.claude/
```

## 目标状态

合并完成后，`~/.claude/settings.json` 必须包含以下字段（已有字段保留、同名字段合并）：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/statusband"
  },
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.claude/hooks/worktree-create.sh\"", "timeout": 120 } ] }
    ],
    "WorktreeRemove": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.claude/hooks/worktree-remove.sh\"", "timeout": 60 } ] }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "\"$HOME/.claude/hooks/guard-worktree-edits.sh\"", "timeout": 10 } ]
      }
    ]
  }
}
```

旧 statusline（`install.sh --statusline`，已被 statusband mod 取代）在把 `statusline/statusline.sh` 拷成 `~/.claude/statusline-command.sh`、`hooks/last-reply.sh` 拷进 `~/.claude/hooks/` 之后，再加：

```json
{
  "statusLine": { "type": "command", "command": "bash ~/.claude/statusline-command.sh" },
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.claude/hooks/last-reply.sh\"", "timeout": 5 } ] }
    ]
  }
}
```

## 合并规则

- **`hooks.<事件>`**：事件槽位是空的，直接把上面的条目放进去；用户已经有其他 hook 并排运行，把新条目**追加**到数组末尾即可（CC 会顺序触发所有）。不要删除用户原有条目。
- **`env.CLAUDE_CODE_PLUGIN_DIRS`**：用 `:` 分隔的插件目录列表。已经列了别的目录就用 `:` **追加** `~/.claude/mods/statusband`，不要删掉原有的。
- **`statusLine`**（仅旧 statusline）：**单值字段**。用户已设置为别的脚本，先和用户确认再覆盖。statusband mod 和旧 statusline 可以同时开，只是很多信息会显示两遍。

## 操作步骤（手动）

1. **先备份**：
   ```bash
   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d-%H%M%S)
   ```
2. 先拷运行时文件（见上），再用你习惯的编辑器按"目标状态"的片段合并
3. 校验 JSON：
   ```bash
   jq empty ~/.claude/settings.json
   ```
4. 开一个新的 Claude Code session（hooks 也可用 `/hooks` 重载；mod 在 session 启动时加载）

## 操作步骤（让 Claude 代劳）

如果 `install.sh` 报了冲突，在 Claude Code 里把下面这段贴进来：

> 读我 claude-utils 克隆里的 `docs/SETTINGS_MERGE.zh.md`，把它列的运行时文件拷进 `~/.claude/`，然后把必要条目合并进 `~/.claude/settings.json`。合并前务必先备份到 `settings.json.bak.<timestamp>`。冲突字段请先告诉我再动。

## 卸载

删除"目标状态"里列出的字段（加过旧 statusline 的连同那几项），再删掉拷贝出来的文件：`~/.claude/hooks/{worktree-create,worktree-remove,worktree-lib,guard-worktree-edits,last-reply}.sh`、`~/.claude/mods/statusband/`、`~/.claude/statusline-refresh-caches.sh`、`~/.claude/statusline-command.sh`。现阶段暂无 `uninstall.sh`。
