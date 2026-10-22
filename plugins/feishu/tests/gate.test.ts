import { describe, expect, test } from 'bun:test'
import {
  defaultAccess,
  gate,
  pruneAccess,
  recordSeenGroup,
  recordSeenSender,
  SEEN_GROUPS_CAP,
  SEEN_SENDERS_CAP,
  SEEN_TTL_MS,
  type Access,
  type FeishuMessageEvent,
  type GateContext,
} from '../lib.ts'
import { parseContent } from '../lib.ts'
import {
  ALICE,
  ALL_MENTION,
  BOB,
  BOT,
  EVE,
  GROUP,
  P2P_ALICE,
  P2P_BOB,
  P2P_EVE,
  botMention,
  event,
} from './fixtures.ts'

const NOW = 1_761_091_200_000

function access(over: Partial<Access> = {}): Access {
  return { ...defaultAccess(), allowFrom: [ALICE], approvers: [BOB], ...over }
}

function ctx(ev: FeishuMessageEvent, over: Partial<GateContext> = {}): GateContext {
  return {
    botOpenId: BOT,
    recentSentIds: new Set(),
    now: NOW,
    text: parseContent(ev.message.message_type, ev.message.content, ev.message.mentions, BOT),
    newPairingCode: () => 'abc123',
    ...over,
  }
}

function run(a: Access, ev: FeishuMessageEvent, over: Partial<GateContext> = {}) {
  return gate(a, ev, ctx(ev, over))
}

describe('p2p', () => {
  test('allowFrom sender is delivered', () => {
    const r = run(access(), event({ sender: ALICE, chatId: P2P_ALICE, text: 'hi' }))
    expect(r.action).toBe('deliver')
  })

  test('approver p2p counts as allowFrom', () => {
    const r = run(access({ allowFrom: [] }), event({ sender: BOB, chatId: P2P_BOB, text: 'hi' }))
    expect(r.action).toBe('deliver')
  })

  test('stranger gets a pairing code (pairing policy)', () => {
    const a = access()
    const r = run(a, event({ sender: EVE, chatId: P2P_EVE, text: 'hi' }))
    expect(r).toEqual({ action: 'pair', code: 'abc123', isResend: false, changed: true })
    expect(a.pending['abc123']).toMatchObject({ senderId: EVE, chatId: P2P_EVE, replies: 1 })
    expect(a.pending['abc123']!.expiresAt).toBe(NOW + 60 * 60 * 1000)
  })

  test('pairing resends once, then goes silent', () => {
    const a = access()
    run(a, event({ sender: EVE, chatId: P2P_EVE, text: 'hi' }))
    const second = run(a, event({ sender: EVE, chatId: P2P_EVE, text: 'hi again' }))
    expect(second).toMatchObject({ action: 'pair', code: 'abc123', isResend: true })
    const third = run(a, event({ sender: EVE, chatId: P2P_EVE, text: 'hello?' }))
    expect(third.action).toBe('drop')
  })

  test('at most 3 pending pairings', () => {
    const a = access()
    for (let i = 0; i < 3; i++) {
      const r = run(a, event({ sender: `ou_s${i}`, chatId: `oc_p2ps${i}`, text: 'x' }), {
        newPairingCode: () => `c0de0${i}`,
      })
      expect(r.action).toBe('pair')
    }
    const r = run(a, event({ sender: 'ou_s9', chatId: 'oc_p2ps9', text: 'x' }))
    expect(r.action).toBe('drop')
  })

  test('expired pairing codes are pruned', () => {
    const a = access({
      pending: { dead00: { senderId: EVE, chatId: P2P_EVE, createdAt: 0, expiresAt: NOW - 1, replies: 2 } },
    })
    const r = run(a, event({ sender: EVE, chatId: P2P_EVE, text: 'hi' }))
    expect(a.pending['dead00']).toBeUndefined()
    expect(r).toMatchObject({ action: 'pair', isResend: false })
  })

  test('allowlist policy drops strangers silently', () => {
    const a = access({ dmPolicy: 'allowlist' })
    const r = run(a, event({ sender: EVE, chatId: P2P_EVE, text: 'hi' }))
    expect(r.action).toBe('drop')
    expect(Object.keys(a.pending)).toHaveLength(0)
  })

  test('disabled drops everything, including allowFrom and groups', () => {
    const a = access({ dmPolicy: 'disabled', groups: { [GROUP]: { requireMention: false, allowFrom: [] } } })
    expect(run(a, event({ sender: ALICE, chatId: P2P_ALICE, text: 'hi' })).action).toBe('drop')
    expect(run(a, event({ sender: BOB, chatId: P2P_BOB, text: 'hi' })).action).toBe('drop')
    expect(
      run(a, event({ sender: ALICE, chatId: GROUP, text: '@_user_1 hi', mentions: [botMention()] })).action,
    ).toBe('drop')
  })

  test('missing sender open_id is dropped', () => {
    const ev = event({ sender: ALICE, chatId: P2P_ALICE, text: 'hi' })
    ev.sender.sender_id = {}
    expect(run(access(), ev).action).toBe('drop')
  })
})

describe('groups', () => {
  const configured = () => access({ groups: { [GROUP]: { requireMention: true, allowFrom: [] } } })

  test('unconfigured group + @bot → drop and record seenGroups', () => {
    const a = access()
    const r = run(a, event({ sender: ALICE, chatId: GROUP, text: '@_user_1 help', mentions: [botMention()] }))
    expect(r).toEqual({ action: 'drop', changed: true, noted: { kind: 'group', chatId: GROUP } })
    expect(a.seenGroups[GROUP]).toEqual({ lastAt: NOW, count: 1 })
    run(a, event({ sender: EVE, chatId: GROUP, text: '@_user_1 again', mentions: [botMention()] }), {
      now: NOW + 5,
    })
    expect(a.seenGroups[GROUP]).toEqual({ lastAt: NOW + 5, count: 2 })
  })

  test('unconfigured group without @ → drop, nothing recorded', () => {
    const a = access()
    const r = run(a, event({ sender: ALICE, chatId: GROUP, text: 'chatter' }))
    expect(r).toEqual({ action: 'drop', changed: false })
    expect(a.seenGroups).toEqual({})
  })

  test('configured group, requireMention, no @ → drop', () => {
    const a = configured()
    const r = run(a, event({ sender: ALICE, chatId: GROUP, text: 'chatter' }))
    expect(r.action).toBe('drop')
    expect(a.seen).toEqual({})
  })

  test('configured group, @bot from a stranger → drop and record seen', () => {
    const a = configured()
    const r = run(a, event({ sender: EVE, chatId: GROUP, text: '@_user_1 do it', mentions: [botMention()] }))
    expect(r).toEqual({ action: 'drop', changed: true, noted: { kind: 'sender', openId: EVE, chatId: GROUP } })
    expect(a.seen[EVE]).toEqual({ chatId: GROUP, lastAt: NOW, count: 1 })
  })

  test('empty group allowFrom: global allowFrom member triggers, stranger does not', () => {
    const a = configured()
    const ok = run(a, event({ sender: ALICE, chatId: GROUP, text: '@_user_1 hi', mentions: [botMention()] }))
    expect(ok.action).toBe('deliver')
    const approver = run(a, event({ sender: BOB, chatId: GROUP, text: '@_user_1 hi', mentions: [botMention()] }))
    expect(approver.action).toBe('deliver')
    const no = run(a, event({ sender: EVE, chatId: GROUP, text: '@_user_1 hi', mentions: [botMention()] }))
    expect(no.action).toBe('drop')
  })

  test('group allowFrom member (not global) triggers', () => {
    const a = access({ groups: { [GROUP]: { requireMention: true, allowFrom: [EVE] } } })
    const r = run(a, event({ sender: EVE, chatId: GROUP, text: '@_user_1 hi', mentions: [botMention()] }))
    expect(r.action).toBe('deliver')
  })

  test('requireMention false: no @ needed; stranger without @ is dropped unrecorded', () => {
    const a = access({ groups: { [GROUP]: { requireMention: false, allowFrom: [] } } })
    expect(run(a, event({ sender: ALICE, chatId: GROUP, text: 'plain' })).action).toBe('deliver')
    expect(run(a, event({ sender: EVE, chatId: GROUP, text: 'plain' }))).toEqual({ action: 'drop', changed: false })
    expect(a.seen).toEqual({})
  })

  test('reply to one of our messages counts as a mention', () => {
    const a = configured()
    const r = run(a, event({ sender: ALICE, chatId: GROUP, text: 'thanks', parentId: 'om_ours' }), {
      recentSentIds: new Set(['om_ours']),
    })
    expect(r.action).toBe('deliver')
    const other = run(a, event({ sender: ALICE, chatId: GROUP, text: 'thanks', parentId: 'om_theirs' }), {
      recentSentIds: new Set(['om_ours']),
    })
    expect(other.action).toBe('drop')
  })

  test('@all does not count as a mention', () => {
    const a = configured()
    const r = run(a, event({ sender: ALICE, chatId: GROUP, text: '@_all standup', mentions: [ALL_MENTION] }))
    expect(r.action).toBe('drop')
    // Even if the @all entry somehow carried the bot's open_id.
    const weird = run(
      a,
      event({ sender: ALICE, chatId: GROUP, text: '@_all hi', mentions: [{ ...ALL_MENTION, id: { open_id: BOT } }] }),
    )
    expect(weird.action).toBe('drop')
  })

  test('@ of another user is not a mention', () => {
    const a = configured()
    const r = run(
      a,
      event({
        sender: ALICE,
        chatId: GROUP,
        text: '@_user_1 hi',
        mentions: [{ key: '@_user_1', id: { open_id: EVE }, name: 'Eve' }],
      }),
    )
    expect(r.action).toBe('drop')
  })

  test('mentionPatterns match case-insensitively; bad regex is ignored', () => {
    const a = access({
      groups: { [GROUP]: { requireMention: true, allowFrom: [] } },
      mentionPatterns: ['([', '^hey claude\\b'],
    })
    expect(run(a, event({ sender: ALICE, chatId: GROUP, text: 'HEY Claude, look' })).action).toBe('deliver')
  })

  test('without a bot open_id, structured @ cannot match but reply-to-bot still does', () => {
    const a = configured()
    const r = run(a, event({ sender: ALICE, chatId: GROUP, text: '@_user_1 hi', mentions: [botMention()] }), {
      botOpenId: undefined,
    })
    expect(r.action).toBe('drop')
    const viaReply = run(a, event({ sender: ALICE, chatId: GROUP, text: 'x', parentId: 'om_1x' }), {
      botOpenId: undefined,
      recentSentIds: new Set(['om_1x']),
    })
    expect(viaReply.action).toBe('deliver')
  })
})

describe('seen bookkeeping', () => {
  test('seen is capped at 50, evicting the oldest', () => {
    const a = access()
    for (let i = 0; i < SEEN_SENDERS_CAP + 5; i++) recordSeenSender(a, `ou_${i}`, GROUP, NOW + i)
    expect(Object.keys(a.seen)).toHaveLength(SEEN_SENDERS_CAP)
    expect(a.seen['ou_0']).toBeUndefined()
    expect(a.seen[`ou_${SEEN_SENDERS_CAP + 4}`]).toBeDefined()
  })

  test('seenGroups is capped at 20', () => {
    const a = access()
    for (let i = 0; i < SEEN_GROUPS_CAP + 3; i++) recordSeenGroup(a, `oc_${i}`, NOW + i)
    expect(Object.keys(a.seenGroups)).toHaveLength(SEEN_GROUPS_CAP)
    expect(a.seenGroups['oc_0']).toBeUndefined()
  })

  test('entries older than 7 days are pruned; a kept name survives updates', () => {
    const a = access({
      seen: {
        [EVE]: { chatId: GROUP, name: 'Eve', lastAt: NOW - SEEN_TTL_MS - 1, count: 3 },
        [ALICE]: { chatId: GROUP, name: 'Alice', lastAt: NOW - 1000, count: 1 },
      },
      seenGroups: { [GROUP]: { lastAt: NOW - SEEN_TTL_MS - 1, count: 1 } },
    })
    expect(pruneAccess(a, NOW)).toBe(true)
    expect(a.seen[EVE]).toBeUndefined()
    expect(a.seenGroups[GROUP]).toBeUndefined()
    recordSeenSender(a, ALICE, 'oc_other', NOW)
    expect(a.seen[ALICE]).toEqual({ chatId: 'oc_other', name: 'Alice', lastAt: NOW, count: 2 })
  })
})
