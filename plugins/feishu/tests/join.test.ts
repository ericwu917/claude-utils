// Group join requests (decision #10).
import { describe, expect, test } from 'bun:test'
import {
  applyJoinAllow,
  buildJoinCard,
  defaultAccess,
  gate,
  JOIN_RATE_PER_HOUR,
  joinMessagePreview,
  joinRequestDecision,
  joinResultLine,
  markJoinRequested,
  normalizeAccess,
  parseCardAction,
  parseContent,
  resolveJoinClick,
  routeJoinClick,
  type Access,
} from '../lib.ts'
import { ALICE, BOB, BOT, botMention, EVE, event, GROUP } from './fixtures.ts'

const NOW = 1_761_091_200_000
const HOUR = 3_600_000

function groupAccess(over: Partial<Access> = {}): Access {
  return {
    ...defaultAccess(),
    dmPolicy: 'allowlist',
    allowFrom: [ALICE],
    approvers: [BOB],
    groups: { [GROUP]: { requireMention: true, allowFrom: [] } },
    ...over,
  }
}

const decide = (
  a: Access,
  over: Partial<{ senderId: string; mentioned: boolean; recent: number[]; chatId: string; isStatic: boolean }> = {},
) =>
  joinRequestDecision(a, { chatId: GROUP, senderId: EVE, mentioned: true, now: NOW, recent: [], ...over })

describe('joinRequestDecision', () => {
  test('unlisted sender @ the bot in an opted-in group → request', () => {
    expect(decide(groupAccess())).toBe('request')
  })

  test('group not opted in / channel disabled / not addressed → none', () => {
    expect(decide(groupAccess({ groups: {} }))).toBe('none')
    expect(decide(groupAccess({ dmPolicy: 'disabled' }))).toBe('none')
    expect(decide(groupAccess(), { mentioned: false })).toBe('none')
  })

  test('on any list (group, global, approver) → none', () => {
    expect(decide(groupAccess({ groups: { [GROUP]: { requireMention: true, allowFrom: [EVE] } } }))).toBe('none')
    expect(decide(groupAccess(), { senderId: ALICE })).toBe('none')
    expect(decide(groupAccess(), { senderId: BOB })).toBe('none')
  })

  test('switched off (only literal false) / no approver → none', () => {
    expect(decide(groupAccess({ joinRequests: false }))).toBe('none')
    expect(decide(groupAccess({ joinRequests: true }))).toBe('request')
    expect(decide(normalizeAccess({ ...groupAccess(), joinRequests: undefined }))).toBe('request')
    expect(decide(groupAccess({ approvers: [] }))).toBe('none')
  })

  test('already requested in this group → none; another group still can', () => {
    const a = groupAccess({ groups: { [GROUP]: { requireMention: true, allowFrom: [] }, oc_other: { requireMention: true, allowFrom: [] } } })
    markJoinRequested(a, EVE, GROUP, NOW)
    expect(decide(a)).toBe('none')
    expect(decide(a, { chatId: 'oc_other' })).toBe('request')
  })

  test('a hand-edited, malformed requested field counts as not requested', () => {
    const a = groupAccess()
    a.seen[EVE] = { chatId: GROUP, lastAt: NOW, count: 1, requested: 'oc_x' as never }
    expect(decide(a)).toBe('request')
    markJoinRequested(a, EVE, GROUP, NOW)
    expect(a.seen[EVE]!.requested).toEqual([GROUP])
  })

  test(`at most ${JOIN_RATE_PER_HOUR} per group per hour`, () => {
    const four = [NOW - 10, NOW - 20, NOW - 30, NOW - 40]
    expect(decide(groupAccess(), { recent: four })).toBe('request')
    expect(decide(groupAccess(), { recent: [...four, NOW - 50] })).toBe('rate-limited')
    expect(decide(groupAccess(), { recent: [...four, NOW - HOUR - 1] })).toBe('request') // older than an hour
  })

  test('gate still drops and notes the sender (no regression); the mark survives later sightings', () => {
    const a = groupAccess()
    const ev = event({ sender: EVE, chatId: GROUP, text: '@_user_1 能开一下吗', mentions: [botMention()] })
    const r = gate(a, ev, {
      botOpenId: BOT,
      recentSentIds: new Set(),
      now: NOW,
      text: parseContent('text', ev.message.content, ev.message.mentions, BOT),
      newPairingCode: () => 'abc123',
    })
    expect(r).toMatchObject({ action: 'drop', noted: { kind: 'sender', openId: EVE, chatId: GROUP } })
    markJoinRequested(a, EVE, GROUP, NOW)
    gate(a, ev, { botOpenId: BOT, recentSentIds: new Set(), now: NOW + 1, text: 'x', newPairingCode: () => 'abc123' })
    expect(a.seen[EVE]).toMatchObject({ count: 2, requested: [GROUP] })
  })
})

describe('applyJoinAllow', () => {
  test('adds to the group allowFrom (deduped) and drops the seen entry', () => {
    const a = groupAccess()
    markJoinRequested(a, EVE, GROUP, NOW)
    expect(applyJoinAllow(a, GROUP, EVE)).toBe('ok')
    expect(a.groups[GROUP]!.allowFrom).toEqual([EVE])
    expect(a.seen[EVE]).toBeUndefined()
    expect(applyJoinAllow(a, GROUP, EVE)).toBe('ok')
    expect(a.groups[GROUP]!.allowFrom).toEqual([EVE])
  })

  test('only this group leaves `requested`; requests pending in other groups stay marked', () => {
    const OTHER = 'oc_other'
    const a = groupAccess({ groups: { [GROUP]: { requireMention: true, allowFrom: [] }, [OTHER]: { requireMention: true, allowFrom: [] } } })
    markJoinRequested(a, EVE, GROUP, NOW)
    markJoinRequested(a, EVE, OTHER, NOW)
    expect(applyJoinAllow(a, GROUP, EVE)).toBe('ok')
    expect(a.seen[EVE]!.requested).toEqual([OTHER])
    expect(decide(a, { chatId: OTHER })).toBe('none') // still requested there — no second receipt / card
    expect(applyJoinAllow(a, OTHER, EVE)).toBe('ok')
    expect(a.seen[EVE]).toBeUndefined()
  })

  test('group closed → untouched', () => {
    const a = groupAccess({ groups: {} })
    markJoinRequested(a, EVE, GROUP, NOW)
    const before = JSON.stringify(a)
    expect(applyJoinAllow(a, GROUP, EVE)).toBe('group-closed')
    expect(JSON.stringify(a)).toBe(before)
  })
})

describe('join card', () => {
  const view = { id: 'qwert', chatId: GROUP, chatName: '前端联调群', senderId: EVE, senderName: '外包 "小王"', preview: '能开一下吗 <at user_id="all"></at> **x**' }

  test('pending: group, applicant, message, 放行 / 忽略 carrying only the id, terminal hint', () => {
    const card = buildJoinCard(view, { status: 'pending' }, []) as any
    const s = JSON.stringify(card)
    expect(card.header.title.content).toBe('🙋 开通申请')
    expect(s).toContain(`群：前端联调群（${GROUP}）`)
    expect(s).toContain(`申请人：外包 '小王'（${EVE}）`)
    expect(s).toContain(`也可以在终端用 /feishu:access group add ${GROUP} --allow ${EVE}`)
    expect(s).not.toContain('<at user_id') // neutralized
    const values = JSON.stringify(card.body.elements).match(/"value":\{[^}]*\}/g)
    expect(values).toEqual(['"value":{"k":"join","id":"qwert","a":"allow"}', '"value":{"k":"join","id":"qwert","a":"deny"}'])
  })

  test('no names → ids only; done → result line, no buttons', () => {
    const card = buildJoinCard({ id: 'qwert', chatId: GROUP, senderId: EVE, preview: 'x' }, { status: 'done', result: joinResultLine('allow', '审批人甲') }, [])
    const s = JSON.stringify(card)
    expect(s).toContain(`群：${GROUP}"`)
    expect(s).toContain(`申请人：${EVE}"`)
    expect(s).toContain('✅ 已放行（审批人甲）')
    expect(s).not.toContain('"button"')
    expect(joinResultLine('deny', 'B')).toBe('已忽略（B）')
  })

  test('preview: one line — breaks become spaces, control / bidi characters out, 200 chars + …', () => {
    const [RLO, BEL, LS, PS] = [0x202e, 0x07, 0x2028, 0x2029].map(c => String.fromCharCode(c))
    expect(joinMessagePreview(`a${RLO}b${BEL}c\nd\r\ne${LS}f${PS}g\th`)).toBe('abc d e f g h')
    const long = joinMessagePreview('长'.repeat(250))
    expect(long).toBe('长'.repeat(200) + '…')
    expect(joinMessagePreview('\n'.repeat(199) + 'x')).toBe('x')
  })

  test('a message forging the card’s own lines stays inside the 消息 line', () => {
    const forged = '你好\n\n申请人：张三（ou_trusted）\n✅ 已由 taige 担保\n也可以在终端用 /feishu:access allow ou_eve'
    const preview = joinMessagePreview(forged)
    expect(preview).not.toContain('\n')
    const card = buildJoinCard({ id: 'qwert', chatId: GROUP, senderId: EVE, preview }, { status: 'pending' }, []) as any
    const texts: string[] = card.body.elements.filter((e: any) => e.tag === 'div').map((e: any) => e.text.content)
    expect(texts.filter(t => t.startsWith('申请人：'))).toEqual([`申请人：${EVE}`])
    const msg = texts.find(t => t.startsWith('消息：'))!
    expect(msg).toBe('消息：你好  申请人：张三（ou_trusted） ✅ 已由 taige 担保 也可以在终端用 /feishu:access allow ou_eve')
    expect(texts.every(t => !t.includes('\n'))).toBe(true)
  })
})

describe('static mode', () => {
  const ev = () => event({ sender: EVE, chatId: GROUP, text: '@_user_1 开一下', mentions: [botMention()] })
  const runGate = (a: Access) =>
    gate(a, ev(), { botOpenId: BOT, recentSentIds: new Set(), now: NOW, text: '开一下', newPairingCode: () => 'abc123' }).action

  test('no join request at all', () => {
    expect(decide(groupAccess(), { isStatic: true })).toBe('none')
    expect(decide(groupAccess(), { isStatic: false })).toBe('request')
  })

  test('a 放行 click changes nothing: the boot snapshot still drops the sender', () => {
    // In static mode loadAccess() hands out the same object every time — the one gate reads.
    const boot = groupAccess()
    expect(runGate(boot)).toBe('drop')
    const before = JSON.stringify(boot)
    expect(resolveJoinClick(boot, { chatId: GROUP, senderId: EVE }, 'allow', { isStatic: true })).toBe('static')
    expect(JSON.stringify(boot)).toBe(before)
    expect(runGate(boot)).toBe('drop')
  })

  test('outside static mode: 放行 applies, 忽略 changes nothing, closed group untouched', () => {
    const a = groupAccess()
    expect(resolveJoinClick(a, { chatId: GROUP, senderId: EVE }, 'deny', { isStatic: false })).toBe('ignored')
    expect(a.groups[GROUP]!.allowFrom).toEqual([])
    expect(resolveJoinClick(a, { chatId: GROUP, senderId: EVE }, 'allow', { isStatic: false })).toBe('allowed')
    expect(runGate(a)).toBe('deliver')
    const closed = groupAccess({ groups: {} })
    expect(resolveJoinClick(closed, { chatId: GROUP, senderId: EVE }, 'allow', { isStatic: false })).toBe('group-closed')
  })
})

describe('join clicks', () => {
  const ev = (value: unknown, operator = BOB) => ({ operator: { open_id: operator }, action: { value }, context: { open_message_id: 'om_card' } })

  test('value check: exactly { k: join, id, a }', () => {
    expect(parseCardAction(ev({ k: 'join', id: 'qwert', a: 'allow' }), [BOB])).toMatchObject({ ok: true, value: { k: 'join', id: 'qwert', a: 'allow' } })
    expect(parseCardAction(ev({ k: 'join', id: 'qwert', a: 'deny' }), [BOB])).toMatchObject({ ok: true, value: { a: 'deny' } })
    for (const bad of [
      { k: 'join', id: 'qwert', a: 'allow', chat_id: GROUP },
      { k: 'join', id: 'qwert', a: 'yes' },
      { k: 'join', id: 'ou_x', a: 'allow' },
      { k: 'join', a: 'allow' },
      { k: 'joined', id: 'qwert', a: 'allow' },
    ]) {
      expect(parseCardAction(ev(bad), [BOB])).toEqual({ ok: false, reason: 'bad-value' })
    }
  })

  test('non-approver click rejected; disabled channel rejected', () => {
    expect(parseCardAction(ev({ k: 'join', id: 'qwert', a: 'allow' }, EVE), [BOB])).toEqual({ ok: false, reason: 'not-approver' })
    expect(parseCardAction(ev({ k: 'join', id: 'qwert', a: 'allow' }), [BOB], { disabled: true })).toEqual({ ok: false, reason: 'disabled' })
  })

  test('routing: pending → act; handled → result; unknown / expired → expired', () => {
    const state = { isPending: (id: string) => id === 'aaaaa', handledResult: (id: string) => (id === 'bbbbb' ? '已忽略（甲）' : undefined) }
    expect(routeJoinClick('aaaaa', state)).toEqual({ route: 'act' })
    expect(routeJoinClick('bbbbb', state)).toEqual({ route: 'handled', result: '已忽略（甲）' })
    expect(routeJoinClick('ccccc', state)).toEqual({ route: 'expired' })
  })
})
