#!/usr/bin/env bash
# Stop hook: records when CC last finished replying in this session.
#
#   Input  (stdin JSON): Claude Code's Stop payload. We only need .session_id.
#   Output (file): ~/.claude/session-meta/<session_id>/last-reply.json with
#     shape {"at": <epoch>}. statusline.sh reads this to render the
#     "⏱ HH:MM (Xh ago)" segment so you can tell at a glance when CC last
#     responded — useful when resuming a session hours or days later.
#
#   Layout rationale: one subdirectory per session, one file per "feature"
#   under it. Future features (e.g. UserPromptSubmit → last-user-prompt.json,
#   session-level counters → session.json) get their own files; no key-space
#   coordination across hooks, no concurrent-write locking required. Pruning
#   stale sessions is a single rm -rf of the session directory.
#
#   Cleanup: on every invocation, feature files older than 30 days are
#   unlinked; session directories left empty by that sweep are also removed.
#   Since this hook re-touches its file on every Stop, a session "ages out"
#   exactly when it stops being active.
#
#   Non-critical: all errors are logged to ~/.claude/last-reply-hook.log and
#   the hook always exits 0 — Stop hook failures must not surface to the user.

set -uo pipefail

STDIN_JSON="$(cat)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
META_ROOT="$CLAUDE_DIR/session-meta"
LOG="$CLAUDE_DIR/last-reply-hook.log"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG" 2>/dev/null || true; }

# Probe multiple paths in case the field name shifts — same defensive pattern
# as hooks/worktree-create.sh. .session_id is the documented key as of CC 2.x.
SESSION_ID="$(printf '%s' "$STDIN_JSON" | jq -r '
  .session_id // .sessionId // .hookSpecificOutput.session_id // empty
' 2>/dev/null || true)"

if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  log "no session_id in stdin; skipping"
  exit 0
fi

SESSION_DIR="$META_ROOT/$SESSION_ID"
FILE="$SESSION_DIR/last-reply.json"

if ! mkdir -p "$SESSION_DIR" 2>/dev/null; then
  log "mkdir $SESSION_DIR failed"
  exit 0
fi

NOW=$(date +%s)

# Atomic write via temp+rename: statusline may read concurrently and we don't
# want it to ever see a half-written file. mktemp next to the target keeps the
# mv on the same filesystem (guaranteed atomic rename on POSIX).
tmp=$(mktemp "${FILE}.XXXXXX" 2>/dev/null) || { log "mktemp failed for $FILE"; exit 0; }
if jq -n --argjson t "$NOW" '{at: $t}' > "$tmp" 2>/dev/null; then
  mv "$tmp" "$FILE"
else
  rm -f "$tmp"
  log "jq write failed for $FILE"
  exit 0
fi

# Prune in two passes:
#   1. Delete feature files whose mtime > 30d (they stopped being touched).
#   2. Remove session directories left empty by pass 1.
# -mindepth 2 on pass 1 scopes us to <session_id>/<feature>.json only.
# -mindepth/-maxdepth 1 on pass 2 targets session dirs themselves. Errors
# silenced — housekeeping must never block the hook.
find "$META_ROOT" -mindepth 2 -type f -name '*.json' -mtime +30 -delete 2>/dev/null || true
find "$META_ROOT" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true

exit 0
