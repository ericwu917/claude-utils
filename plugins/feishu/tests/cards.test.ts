import { describe, expect, test } from 'bun:test'
import {
  buildApprovalCard,
  buildDraftSegments,
  CARD_MAX_BYTES,
  cardResultLine,
  DRAFT_LINE_PREFIX,
  parseCardAction,
  routeCardAction,
  serializeCard,
  type CardButtonValue,
  type PermissionCardView,
  type ReplyCardView,
} from '../lib.ts'

const SECRET = 'SUPERSECRET123'
const APPROVER = 'ou_approver000000000000000000000'
const STRANGER = 'ou_stranger00000000000000000000'

const perm: PermissionCardView = {
  kind: 'perm',
  id: 'qwert',
  toolName: 'Bash',
  description: 'List files <at user_id="all"></at>',
  inputPreview: JSON.stringify({ command: `curl -H "Authorization: Bearer t-g1044abcdefghijkl" x ${SECRET}` }),
}

const reply: ReplyCardView = {
  kind: 'reply',
  id: 'asdfg',
  target: '群 "前端联调"（oc_1）',
  replyTo: 'om_9',
  text: '已修复，**请重试** [详情](https://evil.example) <at user_id="all"></at>',
}

// Every { tag, content } text object in the card, wherever it sits.
function textObjects(node: unknown, out: { tag: string; content: string }[] = []): { tag: string; content: string }[] {
  if (Array.isArray(node)) {
    for (const n of node) textObjects(n, out)
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (typeof o.content === 'string' && typeof o.tag === 'string') out.push({ tag: o.tag, content: o.content })
    for (const v of Object.values(o)) textObjects(v, out)
  }
  return out
}

function buttons(card: unknown): { label: string; value: CardButtonValue }[] {
  const found: { label: string; value: CardButtonValue }[] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object') return
    const o = n as Record<string, any>
    if (o.tag === 'button') {
      const cb = (o.behaviors as any[]).find(b => b.type === 'callback')
      found.push({ label: o.text.content, value: cb.value })
    }
    Object.values(o).forEach(walk)
  }
  walk(card)
  return found
}

const ZW = String.fromCharCode(0x200b)
const allText = (card: unknown) => textObjects(card).map(t => t.content).join('\n')

describe('buildApprovalCard', () => {
  test('permission card: JSON 2.0, shared, plain_text only, redacted, buttons, hint', () => {
    const card = buildApprovalCard(perm, { status: 'pending' }, [SECRET]) as any
    expect(card.schema).toBe('2.0')
    expect(card.config.update_multi).toBe(true)
    expect(card.header.title.content).toBe('🔐 Claude 请求执行工具')
    const texts = textObjects(card)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every(t => t.tag === 'plain_text')).toBe(true)
    const body = allText(card)
    expect(body).toContain('工具：Bash')
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('t-g1044')
    expect(body).toContain('[REDACTED]')
    expect(body).not.toMatch(/<at/i) // neutralized as well
    expect(body.split(ZW).join('')).toContain('<at user_id="all"></at>')
    expect(body).toContain('"command":') // pretty-printed JSON
    expect(body).toContain('也可回复 yes qwert / no qwert')
    expect(buttons(card)).toEqual([
      { label: '允许', value: { k: 'perm', id: 'qwert', a: 'allow' } },
      { label: '拒绝', value: { k: 'perm', id: 'qwert', a: 'deny' } },
    ])
  })

  test('permission card keeps a non-JSON input preview as is', () => {
    const card = buildApprovalCard({ ...perm, inputPreview: 'rm -rf build' }, { status: 'pending' }, [])
    expect(allText(card)).toContain('输入：\nrm -rf build')
  })

  test('reply card: target in title, full draft as plain text, send/discard buttons, text fallback hint', () => {
    const card = buildApprovalCard(reply, { status: 'pending' }, [SECRET]) as any
    expect(card.header.title.content).toBe('📝 待发送到 群 "前端联调"（oc_1）')
    expect(textObjects(card).every(t => t.tag === 'plain_text')).toBe(true)
    const body = allText(card)
    expect(body.split(ZW).join('')).toContain(reply.text!)
    expect(body).not.toContain('**')
    expect(body).not.toContain('](')
    expect(body).toContain('引用消息：om_9')
    expect(body).toContain('也可回复 ok asdfg 发送，no asdfg [理由] 丢弃并说明理由')
    expect(buttons(card)).toEqual([
      { label: '发送', value: { k: 'reply', id: 'asdfg', a: 'allow' } },
      { label: '丢弃', value: { k: 'reply', id: 'asdfg', a: 'deny' } },
    ])
  })

  test('reply card redacts secrets in the draft', () => {
    const card = buildApprovalCard({ ...reply, text: `token ${SECRET}` }, { status: 'pending' }, [SECRET])
    expect(allText(card)).not.toContain(SECRET)
  })

  test('done state: no buttons, result line, grey header', () => {
    const card = buildApprovalCard(reply, { status: 'done', result: cardResultLine('reply', 'allow') }, []) as any
    expect(buttons(card)).toEqual([])
    expect(allText(card)).toContain('✅ 已批准，发送中')
    expect(allText(card)).not.toContain('也可回复')
    expect(card.header.template).toBe('grey')
    expect(cardResultLine('perm', 'allow')).toBe('✅ 已允许')
    expect(cardResultLine('perm', 'deny')).toBe('❌ 已拒绝')
    expect(cardResultLine('reply', 'deny')).toBe('🗑 已丢弃')
  })
})

describe('oversized drafts', () => {
  const huge = Array.from({ length: 800 }, (_, i) => `第 ${i} 行：` + '内容'.repeat(20)).join('\n')

  test('serializeCard rejects a card over the size budget, accepts a normal one', () => {
    expect(serializeCard(buildApprovalCard(reply, { status: 'pending' }, []))).not.toBeNull()
    const big = buildApprovalCard({ ...reply, text: huge }, { status: 'pending' }, [])
    expect(serializeCard(big)).toBeNull()
    expect(Buffer.byteLength(JSON.stringify(JSON.stringify(big)))).toBeGreaterThan(CARD_MAX_BYTES)
  })

  test('degraded path: text segments without the code, then a buttons-only card', () => {
    const segs = buildDraftSegments({ target: reply.target, replyTo: reply.replyTo, text: huge, limit: 4000 }, [])
    expect(segs.length).toBeGreaterThan(1)
    segs.forEach((s, i) => {
      expect(s.startsWith(`（第 ${i + 1}/${segs.length} 段，审批按钮在随后的卡片里）\n`)).toBe(true)
      expect(s).not.toContain(reply.id)
      expect(s.length).toBeLessThanOrEqual(4000)
    })
    const pieces = segs
      .flatMap(s => s.split('\n'))
      .filter(l => l.startsWith(DRAFT_LINE_PREFIX))
      .map(l => l.slice(DRAFT_LINE_PREFIX.length))
    expect(pieces.join('')).toBe(huge.split('\n').join(''))

    const tail = buildApprovalCard({ ...reply, text: undefined, draftSegments: segs.length }, { status: 'pending' }, [])
    expect(serializeCard(tail)).not.toBeNull()
    expect(allText(tail)).toContain(`草稿见上方 ${segs.length} 段`)
    expect(allText(tail)).not.toContain('第 0 行')
    expect(buttons(tail)).toHaveLength(2)
  })
})

describe('parseCardAction', () => {
  const ev = (value: unknown, operator = APPROVER) => ({
    operator: { open_id: operator },
    action: { value, tag: 'button' },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_p2p' },
  })
  const ok = { k: 'reply', id: 'asdfg', a: 'allow' }

  test('approver click with a well-formed value', () => {
    expect(parseCardAction(ev(ok), [APPROVER])).toEqual({
      ok: true,
      operator: APPROVER,
      messageId: 'om_card',
      chatId: 'oc_p2p',
      value: { k: 'reply', id: 'asdfg', a: 'allow' },
    })
  })

  test('value delivered as a JSON string is accepted', () => {
    const r = parseCardAction(ev(JSON.stringify({ k: 'perm', id: 'qwert', a: 'deny' })), [APPROVER])
    expect(r).toMatchObject({ ok: true, value: { k: 'perm', id: 'qwert', a: 'deny' } })
  })

  test('non-approver is rejected (even with a valid value); missing operator too', () => {
    expect(parseCardAction(ev(ok, STRANGER), [APPROVER])).toEqual({ ok: false, reason: 'not-approver' })
    expect(parseCardAction({ action: { value: ok } }, [APPROVER])).toEqual({ ok: false, reason: 'not-approver' })
    expect(parseCardAction(null, [APPROVER])).toEqual({ ok: false, reason: 'not-approver' })
  })

  test.each([
    ['extra key', { ...ok, x: 1 }],
    ['missing key', { k: 'reply', id: 'asdfg' }],
    ['unknown kind', { ...ok, k: 'admin' }],
    ['unknown decision', { ...ok, a: 'approve' }],
    ['code with l', { ...ok, id: 'hello' }],
    ['code too long', { ...ok, id: 'asdfgh' }],
    ['uppercase code', { ...ok, id: 'ASDFG' }],
    ['non-string code', { ...ok, id: 12345 }],
    ['array', ['reply', 'asdfg', 'allow']],
    ['bad JSON string', '{k:reply'],
    ['missing value', undefined],
  ])('forged value rejected: %s', (_name, value) => {
    expect(parseCardAction(ev(value), [APPROVER])).toEqual({ ok: false, reason: 'bad-value' })
  })
})

describe('routeCardAction', () => {
  const none = () => false
  const has = (codes: string[]) => (c: string) => codes.includes(c)

  test('k = perm goes to the permission path', () => {
    expect(
      routeCardAction({ k: 'perm', id: 'qwert', a: 'allow' }, {
        hasPendingReply: has(['qwert']), // even if a reply had the same code
        wasReplyHandled: none,
        wasPermissionHandled: none,
      }),
    ).toEqual({ route: 'permission-verdict', requestId: 'qwert', behavior: 'allow' })
    expect(
      routeCardAction({ k: 'perm', id: 'qwert', a: 'deny' }, {
        hasPendingReply: none,
        wasReplyHandled: none,
        wasPermissionHandled: has(['qwert']),
      }),
    ).toEqual({ route: 'permission-handled', requestId: 'qwert' })
  })

  test('k = reply goes to the reply-approval path', () => {
    const state = { hasPendingReply: has(['asdfg']), wasReplyHandled: has(['zxcvb']), wasPermissionHandled: has(['asdfg']) }
    expect(routeCardAction({ k: 'reply', id: 'asdfg', a: 'allow' }, state)).toEqual({
      route: 'reply-verdict',
      code: 'asdfg',
      approve: true,
    })
    expect(routeCardAction({ k: 'reply', id: 'asdfg', a: 'deny' }, state)).toEqual({
      route: 'reply-verdict',
      code: 'asdfg',
      approve: false,
    })
    expect(routeCardAction({ k: 'reply', id: 'zxcvb', a: 'allow' }, state)).toEqual({ route: 'reply-handled', code: 'zxcvb' })
    expect(routeCardAction({ k: 'reply', id: 'qqqqq', a: 'allow' }, state)).toEqual({ route: 'reply-expired', code: 'qqqqq' })
  })
})
