import { describe, expect, test } from 'bun:test'
import { defaultAccess, gate, parseContent, type Access, type FeishuMessageEvent } from '../lib.ts'
import {
  REAL_BOT,
  REAL_GROUP,
  REAL_GROUP_AT,
  REAL_GROUP_AT_BOLD,
  REAL_P2P_TEXT,
  REAL_USER,
} from './real-events.ts'

const NOW = 1_761_091_200_000

function run(a: Access, ev: FeishuMessageEvent) {
  return gate(a, ev, {
    botOpenId: REAL_BOT,
    recentSentIds: new Set(),
    now: NOW,
    text: parseContent(ev.message.message_type, ev.message.content, ev.message.mentions, REAL_BOT),
    newPairingCode: () => 'abc123',
  })
}

describe('real events', () => {
  test('p2p text parses and is delivered to an allowlisted sender', () => {
    const ev = REAL_P2P_TEXT
    expect(parseContent(ev.message.message_type, ev.message.content, ev.message.mentions, REAL_BOT)).toBe('hi')
    expect(run({ ...defaultAccess(), allowFrom: [REAL_USER] }, ev).action).toBe('deliver')
  })

  test('p2p text from a stranger gets a pairing code', () => {
    expect(run(defaultAccess(), REAL_P2P_TEXT)).toMatchObject({ action: 'pair', code: 'abc123' })
  })

  test('group @bot strips the bot placeholder', () => {
    const ev = REAL_GROUP_AT
    expect(parseContent(ev.message.message_type, ev.message.content, ev.message.mentions, REAL_BOT)).toBe('测试一下')
    const ev2 = REAL_GROUP_AT_BOLD
    expect(parseContent(ev2.message.message_type, ev2.message.content, ev2.message.mentions, REAL_BOT)).toBe('富文本 加粗')
  })

  test('group @bot is delivered for a listed sender in a configured group', () => {
    const a: Access = {
      ...defaultAccess(),
      groups: { [REAL_GROUP]: { requireMention: true, allowFrom: [REAL_USER] } },
    }
    expect(run(a, REAL_GROUP_AT).action).toBe('deliver')
  })

  test('group @bot from an unconfigured group is dropped and noted', () => {
    const a = defaultAccess()
    const r = run(a, REAL_GROUP_AT)
    expect(r.action).toBe('drop')
    expect(a.seenGroups[REAL_GROUP]).toBeDefined()
  })
})
