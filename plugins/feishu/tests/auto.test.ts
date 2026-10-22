import { describe, expect, test } from 'bun:test'
import {
  applyAutoCommandTo,
  AUTO_USAGE,
  AUTO_WRITE_FAILED,
  autoExpiryDue,
  buildAutoCard,
  buildAutoSendCopy,
  defaultAccess,
  describeAuto,
  DRAFT_LINE_PREFIX,
  isAutoActive,
  parseAutoCommand,
  parseCardAction,
  replyApprovalMode,
  type Access,
} from '../lib.ts'

const APPROVER = 'ou_approver000000000000000000000'
const ALICE = 'ou_alice00000000000000000000000'
const NOW = 1_761_091_200_000
const HOUR = 3_600_000
const p2p = { chatType: 'p2p', isApprover: true }

describe('parseAutoCommand', () => {
  test.each([
    ['auto', { cmd: 'on', hours: 8 }],
    ['auto 8h', { cmd: 'on', hours: 8 }],
    ['auto 1h', { cmd: 'on', hours: 1 }],
    ['auto 72h', { cmd: 'on', hours: 72 }],
    ['auto off', { cmd: 'off' }],
    ['auto status', { cmd: 'status' }],
    ['  AUTO 12H \n', { cmd: 'on', hours: 12 }],
    ['Auto Off', { cmd: 'off' }],
    ['auto   status', { cmd: 'status' }],
  ])('%j → %j', (text, want) => {
    expect(parseAutoCommand(text, p2p)).toEqual(want as never)
  })

  test.each(['auto 0h', 'auto 73h', 'auto 1.5h', 'auto 8', 'auto -1h', 'auto h', 'auto on', 'auto 999h'])(
    '%j → usage, nothing switched',
    text => {
      expect(parseAutoCommand(text, p2p)).toEqual({ cmd: 'usage' })
    },
  )

  test.each(['auto 8h please', 'auto tests are failing', 'please auto', 'autopilot', 'auto-send', 'auto off now'])(
    'extra text %j → not a command',
    text => {
      expect(parseAutoCommand(text, p2p)).toBeNull()
    },
  )

  test('only an approver, only in p2p', () => {
    expect(parseAutoCommand('auto', { chatType: 'p2p', isApprover: false })).toBeNull()
    expect(parseAutoCommand('auto', { chatType: 'group', isApprover: true })).toBeNull()
    expect(parseAutoCommand('auto off', { chatType: 'topic_group', isApprover: true })).toBeNull()
  })

  test('usage text names every form', () => {
    for (const s of ['auto', '<N>h', '1–72', 'auto off', 'auto status']) expect(AUTO_USAGE).toContain(s)
  })
})

describe('replyApprovalMode', () => {
  const base = (over: Partial<Access> = {}): Access => ({ ...defaultAccess(), approvers: [APPROVER], ...over })

  test('off / absent → approval', () => {
    expect(replyApprovalMode(base(), undefined, NOW)).toBe('approval')
    expect(replyApprovalMode(base({ autoApproveUntil: 0 }), ALICE, NOW)).toBe('approval')
  })

  test('on → auto; boundary: until itself is already off', () => {
    expect(replyApprovalMode(base({ autoApproveUntil: NOW + 1 }), undefined, NOW)).toBe('auto')
    expect(replyApprovalMode(base({ autoApproveUntil: NOW }), undefined, NOW)).toBe('approval')
    expect(replyApprovalMode(base({ autoApproveUntil: NOW - 1 }), undefined, NOW)).toBe('approval')
    expect(isAutoActive({ autoApproveUntil: NOW + 1 }, NOW)).toBe(true)
    expect(isAutoActive({ autoApproveUntil: NOW }, NOW)).toBe(false)
  })

  test('requireReplyApproval false and approver p2p stay direct, auto or not', () => {
    expect(replyApprovalMode(base({ requireReplyApproval: false }), undefined, NOW)).toBe('direct')
    expect(replyApprovalMode(base({ requireReplyApproval: false, autoApproveUntil: NOW + HOUR }), undefined, NOW)).toBe('direct')
    expect(replyApprovalMode(base({ autoApproveUntil: NOW + HOUR }), APPROVER, NOW)).toBe('direct')
  })
})

describe('applyAutoCommandTo', () => {
  const ok = () => true

  test('on: sets until, persists, notes pending drafts', () => {
    const a = defaultAccess()
    const saved: (number | undefined)[] = []
    const r = applyAutoCommandTo(a, { cmd: 'on', hours: 10 }, {
      now: NOW,
      save: x => (saved.push(x.autoApproveUntil), true),
      pendingCount: 2,
    })
    expect(a.autoApproveUntil).toBe(NOW + 10 * HOUR)
    expect(saved).toEqual([NOW + 10 * HOUR])
    expect(r.ok).toBe(true)
    expect(r.note).toContain('已开启 10 小时')
    expect(r.note).toContain('还有 2 条草稿等你审批')
  })

  test('on with nothing pending: no draft note', () => {
    const r = applyAutoCommandTo(defaultAccess(), { cmd: 'on', hours: 8 }, { now: NOW, save: ok, pendingCount: 0 })
    expect(r.note).toBe('已开启 8 小时')
  })

  test('off → 0', () => {
    const a = { ...defaultAccess(), autoApproveUntil: NOW + HOUR }
    const r = applyAutoCommandTo(a, { cmd: 'off' }, { now: NOW, save: ok, pendingCount: 0 })
    expect(a.autoApproveUntil).toBe(0)
    expect(r).toEqual({ ok: true, note: '已关闭，之后的回复恢复审批', forcedOff: false })
  })

  test('write failure: reported, state unchanged', () => {
    const a = { ...defaultAccess(), autoApproveUntil: 0 }
    const r = applyAutoCommandTo(a, { cmd: 'on', hours: 8 }, { now: NOW, save: () => false, pendingCount: 0 })
    expect(r).toEqual({ ok: false, note: AUTO_WRITE_FAILED })
    expect(AUTO_WRITE_FAILED).toBe('设置失败，access.json 当前不可写')
    expect(a.autoApproveUntil).toBe(0)
  })

  test('status and usage never write', () => {
    let writes = 0
    const save = () => (writes++, true)
    expect(applyAutoCommandTo(defaultAccess(), { cmd: 'status' }, { now: NOW, save, pendingCount: 0 })).toEqual({ ok: true })
    expect(applyAutoCommandTo(defaultAccess(), { cmd: 'usage' }, { now: NOW, save, pendingCount: 0 })).toEqual({
      ok: false,
      note: AUTO_USAGE,
    })
    expect(writes).toBe(0)
  })
})

describe('expiry notice', () => {
  test('due once per expiry time', () => {
    const until = NOW + HOUR
    expect(autoExpiryDue(until, NOW, undefined)).toBe(false) // still running
    expect(autoExpiryDue(until, until, undefined)).toBe(true) // reached
    let announced: number | undefined
    let sent = 0
    for (let t = until; t < until + 60_000; t += 5_000) {
      if (autoExpiryDue(until, t, announced)) {
        announced = until
        sent++
      }
    }
    expect(sent).toBe(1)
    // A later, different expiry is announced again.
    expect(autoExpiryDue(until + HOUR, until + HOUR, announced)).toBe(true)
  })

  test('manual off (0) and absent never produce a notice', () => {
    expect(autoExpiryDue(0, NOW, undefined)).toBe(false)
    expect(autoExpiryDue(undefined, NOW, undefined)).toBe(false)
  })
})

describe('status text and control card', () => {
  test('describeAuto', () => {
    expect(describeAuto(0, NOW)).toBe('关闭')
    expect(describeAuto(NOW - 1, NOW)).toBe('关闭')
    const s = describeAuto(NOW + 8 * HOUR, NOW)
    expect(s).toMatch(/^开启，到 \d\d-\d\d \d\d:\d\d（剩余 8 小时 0 分）$/)
    expect(describeAuto(NOW + 5 * 60_000, NOW)).toMatch(/剩余 5 分）$/)
  })

  test('card: title, status, note, on/off buttons with exact values', () => {
    const card = buildAutoCard({ until: NOW + HOUR, now: NOW, note: '已开启 1 小时' }) as any
    expect(card.header.title.content).toBe('🌙 自动发送')
    const json = JSON.stringify(card)
    expect(json).toContain('状态：开启')
    expect(json).toContain('已开启 1 小时')
    const values: unknown[] = []
    const labels: string[] = []
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      if (n.tag === 'button') {
        labels.push(n.text.content)
        values.push(n.behaviors[0].value)
      }
      Object.values(n).forEach(walk)
    }
    walk(card)
    expect(labels).toEqual(['开启 8 小时', '关闭'])
    expect(values).toEqual([{ k: 'auto', a: 'on' }, { k: 'auto', a: 'off' }])
    expect(JSON.stringify(buildAutoCard({ until: 0, now: NOW }))).toContain('状态：关闭')
  })
})

describe('parseCardAction: auto buttons', () => {
  const ev = (value: unknown, operator = APPROVER) => ({
    operator: { open_id: operator },
    action: { value },
    context: { open_message_id: 'om_c', open_chat_id: 'oc_p2p' },
  })

  test('valid on / off from an approver', () => {
    expect(parseCardAction(ev({ k: 'auto', a: 'on' }), [APPROVER])).toMatchObject({ ok: true, value: { k: 'auto', a: 'on' } })
    expect(parseCardAction(ev({ a: 'off', k: 'auto' }), [APPROVER])).toMatchObject({ ok: true, value: { k: 'auto', a: 'off' } })
  })

  test('non-approver rejected', () => {
    expect(parseCardAction(ev({ k: 'auto', a: 'on' }, ALICE), [APPROVER])).toEqual({ ok: false, reason: 'not-approver' })
  })

  test.each([
    ['extra id key', { k: 'auto', a: 'on', id: 'qwert' }],
    ['extra hours key', { k: 'auto', a: 'on', h: 72 }],
    ['bad action', { k: 'auto', a: 'forever' }],
    ['perm-style decision', { k: 'auto', a: 'allow' }],
    ['missing a', { k: 'auto' }],
  ])('forged auto value rejected: %s', (_n, value) => {
    expect(parseCardAction(ev(value), [APPROVER])).toEqual({ ok: false, reason: 'bad-value' })
  })

  test('perm / reply validation unchanged', () => {
    expect(parseCardAction(ev({ k: 'perm', a: 'on' }), [APPROVER])).toEqual({ ok: false, reason: 'bad-value' })
    expect(parseCardAction(ev({ k: 'reply', id: 'asdfg', a: 'allow' }), [APPROVER])).toMatchObject({ ok: true })
  })
})

describe('buildAutoSendCopy', () => {
  test('header with target, prefixed lines, redacted', () => {
    const SECRET = 'SUPERSECRET123'
    const segs = buildAutoSendCopy(
      { target: '群 "前端联调"（oc_1）', replyTo: 'om_9', text: `已修复\ntoken ${SECRET} Bearer t-g1044abcdefghijkl`, limit: 4000 },
      [SECRET],
    )
    expect(segs).toHaveLength(1)
    const lines = segs[0]!.split('\n')
    expect(lines[0]).toBe('📤 自动发送到 群 "前端联调"（oc_1）')
    expect(lines[1]).toBe('引用消息：om_9')
    expect(lines).toContain(`${DRAFT_LINE_PREFIX}已修复`)
    expect(segs[0]).not.toContain(SECRET)
    expect(segs[0]).not.toContain('t-g1044')
    expect(segs[0]).toContain('[REDACTED]')
  })

  test('long text is split, every segment marked', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ` + 'x'.repeat(40)).join('\n')
    const segs = buildAutoSendCopy({ target: '群 oc_1', text, limit: 1000 }, [])
    expect(segs.length).toBeGreaterThan(1)
    segs.forEach((s, i) => expect(s.startsWith(`（第 ${i + 1}/${segs.length} 段）\n`)).toBe(true))
  })
})
