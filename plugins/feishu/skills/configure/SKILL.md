---
name: configure
description: Set up the Feishu / Lark channel — save the app ID and app secret and review access policy. Use when the user pastes Feishu app credentials, asks to configure Feishu or Lark, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(echo *)
  - Bash(chmod *)
---

# /feishu:configure — Feishu / Lark Channel Setup

Writes the app credentials to `<state-dir>/.env` and orients the user on
access policy. The server reads both files at boot.

**Resolve the state directory first** (it may be overridden for multi-bot or
per-project setups):

```bash
echo "${FEISHU_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/feishu}"
```

Use the printed path everywhere below in place of `<state-dir>`. The default
is `~/.claude/channels/feishu`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Credentials** — check `<state-dir>/.env` for `FEISHU_APP_ID`,
   `FEISHU_APP_SECRET` and `FEISHU_DOMAIN`. Show the app ID in full (it is
   not secret, looks like `cli_...`), the secret as set/not-set with only the
   first 4 chars followed by `…` (never print the whole secret), and the
   domain (`feishu` when unset; `lark` means Lark international).

2. **Access** — read `<state-dir>/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty lists). Show:
   - DM policy and what it means in one line
   - Allowed senders (`allowFrom`): count and open_ids
   - Approvers: count and open_ids. If empty, warn: replies to groups and
     to anyone but an approver will fail, and permission prompts go nowhere
   - `requireReplyApproval` (default on)
   - Pending pairings: count, with codes
   - Groups opted in: count
   - `seen` / `seenGroups`: counts — point at `/feishu:access` for details

3. **What next** — end with a concrete next step based on state:
   - No credentials → *"Run `/feishu:configure <app_id> <app_secret>` (add
     `lark` as a third argument for Lark international). Both come from the
     developer console → your app → Credentials & Basic Info."*
   - Credentials set, policy is pairing, nobody allowed → *"Message your bot
     in a Feishu direct chat. It replies with a code; approve with
     `/feishu:access pair <code> --approver` to make yourself the approver
     too."*
   - Credentials set, someone allowed but no approver → *"Add an approver:
     `/feishu:access approver add <open_id>`."*
   - Credentials set, someone allowed and an approver → *"Ready. Message your
     bot to reach the assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture open_ids you don't know. Once the IDs are in, pairing has done
its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist and approvers. Tell the user who's in them.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes — type
   `/feishu:access policy allowlist`."* Say this proactively — don't wait to
   be asked. You can't run `/feishu:access` yourself (it only runs when the
   user types it), so always hand them the exact command.
4. **If no, people are missing** → *"Have them message the bot directly;
   you'll approve each with `/feishu:access pair <code>`. Run this skill
   again once everyone's in and we'll lock it."* For group members, there's
   no need to pair: when a stranger @mentions the bot in an opted-in group
   they are recorded under `seen` — `/feishu:access` lists them and
   `/feishu:access allow <open_id>` lets them in.
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"Message your bot directly to capture your own open_id first. Then we'll
   add anyone else and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone, `seen` or a known open_id is the clean path —
   no need to reopen pairing.

Feishu already limits reach (an internal app is visible only inside your
tenant, and the availability scope in the developer console narrows it
further), but that's not a substitute for locking the allowlist. Never frame
`pairing` as the correct long-term choice. Don't skip the lockdown suggestion.

### `<app_id> <app_secret> [feishu|lark]` — save credentials

1. Split `$ARGUMENTS` on whitespace. The first token is the app ID (usually
   starts with `cli_`), the second is the app secret, the optional third is
   the domain — must be `feishu` or `lark`; anything else, tell the user and
   stop. Missing app ID or secret → show the expected form and stop.
2. `mkdir -p <state-dir>` then `chmod 700 <state-dir>`.
3. Read existing `.env` if present; update/add the `FEISHU_APP_ID=`,
   `FEISHU_APP_SECRET=` and (if given) `FEISHU_DOMAIN=` lines, preserve other
   keys. Write back, no quotes around the values.
4. `chmod 600 <state-dir>/.env` — the secret is a credential.
5. Confirm (secret masked), then show the no-args status so the user sees
   where they stand.

### `clear` — remove the credentials

Delete the `FEISHU_APP_ID=`, `FEISHU_APP_SECRET=` and `FEISHU_DOMAIN=` lines
(or the file if those are the only lines).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session
  restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/feishu:access` take effect immediately, no restart.
- Never echo the full app secret back to the user or into any file other
  than `.env`.
