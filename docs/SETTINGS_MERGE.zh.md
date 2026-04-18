# settings.json 手动合并指南

`install.sh` 在两种情况下会退出并要求人工介入：

1. **jq 未安装** —— 合并需要 jq，自动流程无法继续
2. **检测到冲突** —— `~/.claude/settings.json` 里某个事件槽位（`WorktreeCreate` / `WorktreeRemove` / `statusline.command`）已经有了非 claude-utils 的配置，脚本不敢覆盖

本文档告诉你要插入什么、或者如何把这份文档喂给 Claude 让它帮你改。

[English version](SETTINGS_MERGE.md)

## 目标状态

合并完成后，`~/.claude/settings.json` 必须包含以下字段（已有字段保留、同名字段合并）。将所有 `<REPO>` 替换为 `install.sh` 所在仓库的绝对路径（通常是 `$HOME/.claude/claude-utils`）。

```json
{
  "hooks": {
    "WorktreeCreate": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<REPO>/hooks/worktree-create.sh",
            "timeout": 120
          }
        ]
      }
    ],
    "WorktreeRemove": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<REPO>/hooks/worktree-remove.sh",
            "timeout": 60
          }
        ]
      }
    ]
  },
  "statusline": {
    "command": "bash <REPO>/statusline/statusline.sh"
  }
}
```

## 合并规则

- **`hooks.WorktreeCreate` / `WorktreeRemove`**：如果这两个事件槽位是空的，直接把上面的条目数组放进去。如果用户已经有其他 hook 并排运行，把新条目**追加**到数组末尾即可（CC 会顺序触发所有）。不要删除用户原有条目。
- **`statusline.command`**：这是**单值字段**。如果用户已设置为别的脚本，请和用户确认：是覆盖、还是不安装 statusline（本组件可跳过，hooks 照样能装）。

## 操作步骤（手动）

1. **先备份**：
   ```bash
   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d-%H%M%S)
   ```
2. 用你习惯的编辑器按上面"目标状态"节的片段合并
3. 校验 JSON：
   ```bash
   jq empty ~/.claude/settings.json
   ```
4. 重启 Claude Code session（或 `/hooks` 重载）

## 操作步骤（让 Claude 代劳）

如果 `install.sh` 报了冲突，在 Claude Code 里把下面这段贴进来：

> 读 `~/.claude/claude-utils/docs/SETTINGS_MERGE.md`，然后帮我把必要条目合并进 `~/.claude/settings.json`。合并前务必先备份到 `settings.json.bak.<timestamp>`。冲突字段请先告诉我再动。`<REPO>` 用 `~/.claude/claude-utils`（如果我把仓库克隆到别处了我会告诉你）。

## 卸载

手动删除上面列出的对应字段（`hooks.WorktreeCreate`、`hooks.WorktreeRemove`、`statusline.command`），然后 `rm -rf` 仓库目录。现阶段暂无 `uninstall.sh`。
