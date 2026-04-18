# Manual settings.json merge guide

`install.sh` exits and asks for human intervention in two cases:

1. **`jq` is not installed** — the merge needs jq; the automated flow can't continue.
2. **Conflict detected** — `~/.claude/settings.json` already has a non-claude-utils entry in one of the slots (`WorktreeCreate` / `WorktreeRemove` / `statusline.command`) and the script refuses to overwrite.

This document tells you what entries to insert — or how to hand this document to Claude and have it do the merge for you.

[中文版](SETTINGS_MERGE.zh.md)

## Target state

After merging, `~/.claude/settings.json` must contain the fields below (preserve any other existing fields; merge same-named fields). Replace every `<REPO>` with the absolute path to the repo that contains `install.sh` (typically `$HOME/.claude/claude-utils`).

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

## Merge rules

- **`hooks.WorktreeCreate` / `WorktreeRemove`**: if these event slots are empty, drop the array entries above in directly. If the user already has other hooks wired to the same event, **append** the new entry to the array — CC fires all entries in order. Do not remove any of the user's existing entries.
- **`statusline.command`**: this is a **single-value** field. If the user already has a different statusline script configured, ask before replacing. If they want to keep theirs, skip the statusline component; the hooks will still install.

## Manual procedure

1. **Back up first**:
   ```bash
   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d-%H%M%S)
   ```
2. Merge the snippets above with your editor of choice.
3. Validate the JSON:
   ```bash
   jq empty ~/.claude/settings.json
   ```
4. Restart the Claude Code session (or run `/hooks` to reload).

## Let Claude do it

If `install.sh` reports a conflict, paste this into Claude Code:

> Read `~/.claude/claude-utils/docs/SETTINGS_MERGE.md`, then merge the required entries into `~/.claude/settings.json`. Back up to `settings.json.bak.<timestamp>` before writing. If any field conflicts with something I already have, tell me first. Use `~/.claude/claude-utils` for `<REPO>` (I'll tell you if I cloned it somewhere else).

## Uninstall

Manually delete the fields listed under "Target state" (`hooks.WorktreeCreate`, `hooks.WorktreeRemove`, `statusline.command`), then `rm -rf` the repo directory. An `uninstall.sh` is on the roadmap.
