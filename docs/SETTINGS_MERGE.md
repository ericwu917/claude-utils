# Manual settings.json merge guide

`install.sh` exits and asks for human intervention in two cases:

1. **`jq` is not installed** — the merge needs jq; the automated flow can't continue.
2. **Conflict detected** — `~/.claude/settings.json` already has a non-claude-utils entry in one of the slots (`WorktreeCreate` / `WorktreeRemove` / `PreToolUse`, or `statusLine` / `Stop` for the legacy statusline) and the script refuses to overwrite.

This document tells you what entries to insert — or how to hand this document to Claude and have it do the merge for you.

[中文版](SETTINGS_MERGE.zh.md)

## Runtime files

`install.sh` **copies** the runtime into `~/.claude/` (it never points `settings.json` at the repo). If you merge by hand, copy these first, from the repo root:

```bash
mkdir -p ~/.claude/hooks ~/.claude/mods
cp hooks/worktree-create.sh hooks/worktree-remove.sh hooks/worktree-lib.sh hooks/guard-worktree-edits.sh ~/.claude/hooks/
cp -R mods/statusband ~/.claude/mods/
cp statusline/statusline-refresh-caches.sh ~/.claude/
```

## Target state

After merging, `~/.claude/settings.json` must contain the fields below (preserve any other existing fields; merge same-named fields).

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

The legacy statusline (`install.sh --statusline`, replaced by the statusband mod) adds, after copying `statusline/statusline.sh` to `~/.claude/statusline-command.sh` and `hooks/last-reply.sh` to `~/.claude/hooks/`:

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

## Merge rules

- **`hooks.<Event>`**: if the event slot is empty, drop the array entry above in directly. If the user already has other hooks wired to the same event, **append** the new entry to the array — CC fires all entries in order. Do not remove any of the user's existing entries.
- **`env.CLAUDE_CODE_PLUGIN_DIRS`**: a `:`-separated list of plugin folders. If it already lists other folders, **append** `~/.claude/mods/statusband` with a `:`; never drop the others.
- **`statusLine`** (legacy only): a **single-value** field. If the user already has a different statusline configured, ask before replacing. Running both the statusband mod and the legacy statusline works, but shows much of the same information twice.

## Manual procedure

1. **Back up first**:
   ```bash
   cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d-%H%M%S)
   ```
2. Copy the runtime files (above), then merge the snippets with your editor of choice.
3. Validate the JSON:
   ```bash
   jq empty ~/.claude/settings.json
   ```
4. Start a new Claude Code session (hooks also reload with `/hooks`; the mod loads at session start).

## Let Claude do it

If `install.sh` reports a conflict, paste this into Claude Code:

> Read `docs/SETTINGS_MERGE.md` in my claude-utils clone, copy the runtime files it lists into `~/.claude/`, then merge the required entries into `~/.claude/settings.json`. Back up to `settings.json.bak.<timestamp>` before writing. If any field conflicts with something I already have, tell me first.

## Uninstall

Delete the fields listed under "Target state" (and the legacy ones if you added them), then remove the copied files: `~/.claude/hooks/{worktree-create,worktree-remove,worktree-lib,guard-worktree-edits,last-reply}.sh`, `~/.claude/mods/statusband/`, `~/.claude/statusline-refresh-caches.sh`, `~/.claude/statusline-command.sh`. An `uninstall.sh` is on the roadmap.
