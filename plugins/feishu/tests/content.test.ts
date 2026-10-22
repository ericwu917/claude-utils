import { describe, expect, test } from 'bun:test'
import {
  approvalTargetLabel,
  buildApprovalNotice,
  chunk,
  createAccessReader,
  DRAFT_LINE_PREFIX,
  formatLogArgs,
  lockedDownAccess,
  NAME_MAX_CHARS,
  neutralizeMarkup,
  newApprovalCode,
  noteBounded,
  parseContent,
  parseVerdict,
  PERMISSION_REPLY_RE,
  redact,
  sanitizeName,
} from '../lib.ts'
import { ALL_MENTION, BOT, botMention, userMention } from './fixtures.ts'

describe('parseContent: text', () => {
  test('plain text', () => {
    expect(parseContent('text', JSON.stringify({ text: 'hello world' }), [], BOT)).toBe('hello world')
  })

  test('@_user_N placeholders become @name; the bot placeholder is removed', () => {
    const mentions = [botMention('@_user_1'), userMention('@_user_2', 'ou_x', '张三')]
    const content = JSON.stringify({ text: '@_user_1 请看下 @_user_2 的报错' })
    expect(parseContent('text', content, mentions, BOT)).toBe('请看下 @张三 的报错')
  })

  test('@_user_1 does not clobber @_user_10', () => {
    const mentions = [userMention('@_user_1', 'ou_a', 'A'), userMention('@_user_10', 'ou_j', 'J')]
    const content = JSON.stringify({ text: '@_user_1 and @_user_10' })
    expect(parseContent('text', content, mentions, BOT)).toBe('@A and @J')
  })

  test('@_all becomes @all; unknown placeholders are left alone', () => {
    const content = JSON.stringify({ text: '@_all meeting, cc @_user_7' })
    expect(parseContent('text', content, [ALL_MENTION], BOT)).toBe('@all meeting, cc @_user_7')
  })

  test('without a bot open_id the bot placeholder becomes @name', () => {
    const content = JSON.stringify({ text: '@_user_1 hi' })
    expect(parseContent('text', content, [botMention()], undefined)).toBe('@Claude hi')
  })

  test('unparseable content does not throw', () => {
    expect(parseContent('text', '{not json', [], BOT)).toBe('(unparseable text message)')
    expect(parseContent('text', JSON.stringify({ nope: 1 }), [], BOT)).toBe('(unparseable text message)')
  })
})

describe('parseContent: post', () => {
  const post = {
    title: '联调报错',
    content: [
      [
        { tag: 'at', user_id: '@_user_1', user_name: 'Claude' },
        { tag: 'text', text: ' 接口 500 了，见 ' },
        { tag: 'a', text: '日志', href: 'https://example.com/log' },
      ],
      [
        { tag: 'text', text: '复现：' },
        { tag: 'at', user_id: '@_user_2', user_name: '李四' },
        { tag: 'img', image_key: 'img_xxx' },
        { tag: 'emotion', emoji_type: 'SMILE' },
      ],
      [{ tag: 'code_block', language: 'JSON', text: '{"code":500}' }],
      [{ tag: 'md', text: '**加粗**' }],
    ],
  }
  const mentions = [botMention('@_user_1'), userMention('@_user_2', 'ou_li', '李四')]

  test('flattens title, text, links, @ and code; marks images; drops the bot @ and unknown tags', () => {
    expect(parseContent('post', JSON.stringify(post), mentions, BOT)).toBe(
      '联调报错\n接口 500 了，见 日志 (https://example.com/log)\n复现：@李四[图片 1]\n```json\n{"code":500}\n```\n**加粗**',
    )
  })

  test('accepts the locale-wrapped form', () => {
    const wrapped = { zh_cn: post }
    expect(parseContent('post', JSON.stringify(wrapped), mentions, BOT)).toStartWith('联调报错\n接口 500')
  })

  test('auto-linked emails and URLs keep only their text (pasted curl stays intact)', () => {
    // Shape observed from a real post: Feishu turned the email and URLs inside
    // a pasted curl into links with mailto: / http:// hrefs.
    const p = {
      content: [
        [
          { tag: 'text', text: `--data-raw '{"email":"` },
          { tag: 'a', text: 'user@example.com', href: 'mailto:user@example.com' },
          { tag: 'text', text: `"}' -H 'origin: ` },
          { tag: 'a', text: 'https://app.example.com', href: 'https://app.example.com/' },
          { tag: 'text', text: `' UA Chrome/` },
          { tag: 'a', text: '155.0.0.0', href: 'http://155.0.0.0/' },
        ],
      ],
    }
    expect(parseContent('post', JSON.stringify(p), [], BOT)).toBe(
      `--data-raw '{"email":"user@example.com"}' -H 'origin: https://app.example.com' UA Chrome/155.0.0.0`,
    )
  })

  test('text messages: Markdown auto-links keep only their text, other links stay', () => {
    // Shape observed from a real text message: the same pasted curl, with the
    // auto-links inlined as [text](href).
    const text =
      `-H 'origin: [https://app.example.com](https://app.example.com/)' ` +
      `UA Chrome/[155.0.0.0](http://155.0.0.0/) ` +
      `--data-raw '{"email":"[user@example.com](mailto:user@example.com)"}' ` +
      `see [文档](https://docs.example.com/x) [a](b)`
    expect(parseContent('text', JSON.stringify({ text }), [], BOT)).toBe(
      `-H 'origin: https://app.example.com' UA Chrome/155.0.0.0 ` +
        `--data-raw '{"email":"user@example.com"}' ` +
        `see [文档](https://docs.example.com/x) [a](b)`,
    )
  })

  test('link whose text is the URL prints once; @all in post', () => {
    const p = {
      content: [
        [
          { tag: 'a', text: 'https://x.dev', href: 'https://x.dev' },
          { tag: 'text', text: ' ' },
          { tag: 'at', user_id: 'all' },
        ],
      ],
    }
    expect(parseContent('post', JSON.stringify(p), [], BOT)).toBe('https://x.dev @all')
  })

  test('garbage post is unparseable', () => {
    expect(parseContent('post', JSON.stringify({ title: 'x' }), [], BOT)).toBe('(unparseable post message)')
  })
})

describe('parseContent: other types', () => {
  test.each(['sticker', 'interactive', 'merge_forward'])('%s → placeholder', t => {
    expect(parseContent(t, '{"image_key":"x"}', [], BOT)).toBe(`(${t} message)`)
  })

  test('image / file / media / audio have their own placeholders (see inbox.test.ts)', () => {
    expect(parseContent('image', '{"image_key":"img_x"}', [], BOT)).toBe('[图片 1]')
    expect(parseContent('file', '{"file_key":"file_x","file_name":"a.log"}', [], BOT)).toBe('[文件 1: a.log]')
    expect(parseContent('media', '{"file_key":"file_x","image_key":"img_x"}', [], BOT)).toBe('[视频]')
    expect(parseContent('audio', '{"file_key":"file_x"}', [], BOT)).toBe('[语音]')
  })
})

describe('parseVerdict', () => {
  const none = () => false
  const pending = (codes: string[]) => (c: string) => codes.includes(c)

  test('approver p2p "yes abcde" → permission allow', () => {
    expect(parseVerdict('yes abcde', { chatType: 'p2p', isApprover: true, hasPendingReply: none })).toEqual({
      kind: 'permission',
      request_id: 'abcde',
      behavior: 'allow',
    })
  })

  test('approver p2p "N ABCDE" → permission deny, id lowercased', () => {
    expect(parseVerdict('  N ABCDE ', { chatType: 'p2p', isApprover: true, hasPendingReply: none })).toEqual({
      kind: 'permission',
      request_id: 'abcde',
      behavior: 'deny',
    })
  })

  test('non-approver p2p "yes abcde" → no verdict', () => {
    expect(parseVerdict('yes abcde', { chatType: 'p2p', isApprover: false, hasPendingReply: none })).toBeNull()
  })

  test('approver in a group "yes abcde" → no verdict', () => {
    expect(parseVerdict('yes abcde', { chatType: 'group', isApprover: true, hasPendingReply: none })).toBeNull()
    expect(
      parseVerdict('ok abcde', { chatType: 'group', isApprover: true, hasPendingReply: pending(['abcde']) }),
    ).toBeNull()
  })

  test('"ok <code>" hitting a pending reply → reply approval', () => {
    expect(
      parseVerdict('ok qwert', { chatType: 'p2p', isApprover: true, hasPendingReply: pending(['qwert']) }),
    ).toEqual({ kind: 'reply', approve: true, code: 'qwert' })
  })

  test('F8: y/yes never approve a draft — "yes <pending code>" is flagged as misuse', () => {
    for (const t of ['Yes QWERT', 'y qwert']) {
      expect(
        parseVerdict(t, { chatType: 'p2p', isApprover: true, hasPendingReply: pending(['qwert']) }),
      ).toEqual({ kind: 'reply-misuse', code: 'qwert' })
    }
  })

  test('F8: "yes <id>" stays a permission verdict when the id is a live permission request', () => {
    expect(
      parseVerdict('yes qwert', {
        chatType: 'p2p',
        isApprover: true,
        hasPendingReply: pending(['qwert']),
        isPermissionId: id => id === 'qwert',
      }),
    ).toEqual({ kind: 'permission', request_id: 'qwert', behavior: 'allow' })
  })

  test('F8: "n <code>" rejects a pending reply', () => {
    expect(
      parseVerdict('N qwert', { chatType: 'p2p', isApprover: true, hasPendingReply: pending(['qwert']) }),
    ).toEqual({ kind: 'reply', approve: false, code: 'qwert' })
  })

  test('F9: ok/no for an already-handled code → reply-handled, not permission, not chat', () => {
    const o = { chatType: 'p2p', isApprover: true, hasPendingReply: none, wasReplyHandled: pending(['qwert']) }
    expect(parseVerdict('ok qwert', o)).toEqual({ kind: 'reply-handled', code: 'qwert' })
    expect(parseVerdict('no qwert', o)).toEqual({ kind: 'reply-handled', code: 'qwert' })
    expect(parseVerdict('no qwert 太晚了', o)).toEqual({ kind: 'reply-handled', code: 'qwert' })
    expect(parseVerdict('yes qwert', o)).toEqual({ kind: 'reply-misuse', code: 'qwert' })
    // Other codes are unaffected.
    expect(parseVerdict('no abcde', o)).toEqual({ kind: 'permission', request_id: 'abcde', behavior: 'deny' })
  })

  test('"ok <code>" missing from pendingReplies is not a permission verdict', () => {
    expect(parseVerdict('ok qwert', { chatType: 'p2p', isApprover: true, hasPendingReply: none })).toBeNull()
    expect(PERMISSION_REPLY_RE.test('ok qwert')).toBe(false)
  })

  test('"no <code> <reason>" extracts the reason (multi-line)', () => {
    expect(
      parseVerdict('no qwert 语气太随意\n改正式点 ', {
        chatType: 'p2p',
        isApprover: true,
        hasPendingReply: pending(['qwert']),
      }),
    ).toEqual({ kind: 'reply', approve: false, code: 'qwert', reason: '语气太随意\n改正式点' })
  })

  test('"no <code> <reason>" for an unknown code is neither verdict', () => {
    expect(parseVerdict('no qwert because', { chatType: 'p2p', isApprover: true, hasPendingReply: none })).toBeNull()
  })

  test('chatter and codes containing l are not verdicts', () => {
    const o = { chatType: 'p2p', isApprover: true, hasPendingReply: pending(['hello']) }
    expect(parseVerdict('yes', o)).toBeNull()
    expect(parseVerdict('yes please abcde', o)).toBeNull()
    expect(parseVerdict('yes hello', o)).toBeNull()
  })
})

const ZW = String.fromCharCode(0x200b) // zero-width space

describe('neutralizeMarkup (F4)', () => {
  test('breaks <at> tags so outbound text cannot mention anyone', () => {
    const out = neutralizeMarkup('hi <at user_id="all">所有人</at> and <AT user_id="ou_x"></AT>')
    expect(out).not.toMatch(/<\/?at\b/i)
    expect(out.split(ZW).join('')).toBe('hi <at user_id="all">所有人</at> and <AT user_id="ou_x"></AT>')
  })

  test('breaks every tag, links and bold; leaves comparisons alone', () => {
    const src = 'x <b>bold</b> <i>i</i> <u>u</u> <s>s</s> [docs](https://evil.example) **loud** ***x*** a < 3, a<=b, <5'
    const out = neutralizeMarkup(src)
    expect(out).not.toMatch(/<[A-Za-z/]/)
    expect(out).not.toContain('](')
    expect(out).not.toContain('**')
    expect(out.split(ZW).join('')).toBe(src)
    expect(out).toContain('a < 3, a<=b, <5')
  })
})

describe('redact / formatLogArgs (F1, F5)', () => {
  const SECRET = 'SUPERSECRET123'

  test('redact strips the app secret, Bearer tokens, app_secret pairs and tenant tokens', () => {
    const line =
      `secret=${SECRET} Authorization: Bearer t-g1044abcdefGHIJKLMNOP ` +
      `{"app_id":"cli_x","app_secret":"other"} tok t-g1044ZZZZZZZZZZZZZZ`
    const out = redact(line, [SECRET])
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('t-g1044')
    expect(out).not.toContain('"other"')
    expect(out).toContain('"app_id":"cli_x"')
  })

  test('ordinary hyphenated words survive', () => {
    expect(redact('test-driven-development and out-of-the-box', ['s3cr3t'])).toBe(
      'test-driven-development and out-of-the-box',
    )
  })

  test('an axios-shaped error inside an array logs only message + feishu code/msg', () => {
    const axiosish = {
      message: 'Request failed with status code 400',
      isAxiosError: true,
      config: {
        headers: { Authorization: 'Bearer t-g1044SECRETTOKEN1234' },
        data: JSON.stringify({ app_id: 'cli_x', app_secret: SECRET, content: '{"text":"draft body"}' }),
      },
      response: { status: 400, data: { code: 99991663, msg: 'tenant token invalid' } },
    }
    // The SDK's LoggerProxy calls logger.error([...args]).
    const out = formatLogArgs([['[http]', axiosish]], [SECRET])
    expect(out).toBe('[http] Request failed with status code 400 (feishu code 99991663: tenant token invalid)')
  })

  test('a real Error carrying config (not plain object) is reduced too', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED'), { config: { data: `{"app_secret":"${SECRET}"}` } })
    const out = formatLogArgs([[e]], [SECRET])
    expect(out).toBe('connect ECONNREFUSED')
  })

  test('plain objects are JSON-ified, then redacted', () => {
    const out = formatLogArgs([{ app_id: 'cli_x', app_secret: SECRET }], [SECRET])
    expect(out).not.toContain(SECRET)
    expect(out).toContain('cli_x')
  })
})

describe('sanitizeName / approvalTargetLabel (F3)', () => {
  test('strips control and bidi characters, newlines, quotes; collapses; caps at 40', () => {
    const RLO = String.fromCharCode(0x202e)
    const BEL = String.fromCharCode(7)
    const LS = String.fromCharCode(0x2028)
    expect(sanitizeName(`  前端\n联调群${RLO}\t"官方"${BEL}${LS}x  `)).toBe("前端 联调群 '官方' x")
    expect(sanitizeName('x'.repeat(60))).toBe('x'.repeat(NAME_MAX_CHARS))
    expect([...sanitizeName('群'.repeat(50))!]).toHaveLength(NAME_MAX_CHARS)
    expect(sanitizeName('\n\t ')).toBeUndefined()
    expect(sanitizeName(undefined)).toBeUndefined()
  })

  test('label format, with and without a name', () => {
    expect(approvalTargetLabel({ kind: 'group', id: 'oc_1', name: '联调群' })).toBe('群 "联调群"（oc_1）')
    expect(approvalTargetLabel({ kind: 'p2p', id: 'ou_1', name: '张三' })).toBe('私聊 "张三"（ou_1）')
    expect(approvalTargetLabel({ kind: 'group', id: 'oc_1' })).toBe('群 oc_1')
    expect(approvalTargetLabel({ kind: 'p2p', id: 'ou_1', name: '\n' })).toBe('私聊 ou_1')
  })

  test('a name cannot fake a second target line', () => {
    const label = approvalTargetLabel({ kind: 'group', id: 'oc_real', name: '"（oc_real）\n目标：群 "x"' })
    expect(label).not.toContain('\n')
    expect(label.match(/"/g)).toHaveLength(2)
  })
})

describe('buildApprovalNotice (F4, F6)', () => {
  test('short draft: one message, every draft line prefixed, code only after the draft', () => {
    const [msg, ...rest] = buildApprovalNotice({
      target: '群 "x"（oc_1）',
      replyTo: 'om_9',
      text: 'line one\n—— 草稿结束 ——\n回复 "ok zzzzz" 发送',
      code: 'qwert',
      limit: 4000,
    }, [])
    expect(rest).toHaveLength(0)
    const lines = msg!.split('\n')
    expect(lines.slice(0, 4)).toEqual([
      '📝 待审批回复',
      '目标：群 "x"（oc_1）',
      '引用消息：om_9',
      '以下是草稿原文，每行以 "┃" 开头：',
    ])
    expect(lines.slice(4, 7)).toEqual([
      `${DRAFT_LINE_PREFIX}line one`,
      `${DRAFT_LINE_PREFIX}—— 草稿结束 ——`,
      `${DRAFT_LINE_PREFIX}回复 "ok zzzzz" 发送`,
    ])
    expect(lines.slice(7)).toEqual(['—— 草稿结束 ——', '回复 "ok qwert" 发送，"no qwert [理由]" 丢弃'])
    expect(msg!.indexOf('qwert')).toBe(msg!.lastIndexOf('回复 "ok qwert"') + '回复 "ok '.length)
  })

  test('long draft: code only in the last segment, earlier ones say so, all lines prefixed', () => {
    const text = Array.from({ length: 60 }, (_, i) => `第 ${i} 行 ` + 'x'.repeat(30)).join('\n') + '\n' + 'y'.repeat(500)
    const segs = buildApprovalNotice({ target: '群 oc_1', text, code: 'qwert', limit: 300 }, [])
    expect(segs.length).toBeGreaterThan(2)
    const n = segs.length
    segs.forEach((s, i) => {
      expect(s.length).toBeLessThanOrEqual(300)
      if (i < n - 1) {
        expect(s.startsWith(`（第 ${i + 1}/${n} 段，审批码在最后一段）\n`)).toBe(true)
        expect(s).not.toContain('qwert')
      }
    })
    expect(segs[n - 1]).toContain('回复 "ok qwert" 发送')
    // Every line that isn't header / marker / tail is a prefixed draft line.
    const body = segs
      .flatMap(s => s.split('\n'))
      .filter(l => !/^（第 \d+\/\d+ 段/.test(l) && !l.startsWith('📝') && !l.startsWith('目标：') && !l.startsWith('以下是草稿') && l !== '—— 草稿结束 ——' && !l.startsWith('回复 "ok'))
    expect(body.every(l => l.startsWith(DRAFT_LINE_PREFIX))).toBe(true)
    // Nothing lost: the prefixed pieces reassemble the draft.
    const pieces = body.map(l => l.slice(DRAFT_LINE_PREFIX.length))
    expect(pieces.join('')).toBe(text.split('\n').join(''))
  })
})

describe('createAccessReader (F7)', () => {
  test('missing file → defaults; corrupt file → last good copy, no write allowed', () => {
    let raw: string | null = null
    const warnings: string[] = []
    const r = createAccessReader(() => raw, m => warnings.push(m))
    expect(r.load().dmPolicy).toBe('pairing')
    expect(r.lastReadOk()).toBe(true)

    raw = JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['ou_a'] })
    expect(r.load().allowFrom).toEqual(['ou_a'])

    raw = '{ "dmPolicy": "allowlist", '
    const fallback = r.load()
    expect(fallback.dmPolicy).toBe('allowlist')
    expect(fallback.allowFrom).toEqual(['ou_a'])
    expect(r.lastReadOk()).toBe(false)
    // The fallback is a copy — mutating it doesn't change the cached good one.
    fallback.allowFrom.push('ou_evil')
    expect(r.load().allowFrom).toEqual(['ou_a'])
    expect(warnings).toHaveLength(1) // once per failure streak

    raw = JSON.stringify({ allowFrom: ['ou_b'] })
    expect(r.load().allowFrom).toEqual(['ou_b'])
    expect(r.lastReadOk()).toBe(true)
  })

  test('corrupt before any good load → drop everything', () => {
    const r = createAccessReader(() => 'not json', () => {})
    const a = r.load()
    expect(a).toEqual(lockedDownAccess())
    expect(a.dmPolicy).toBe('disabled')
    expect(r.lastReadOk()).toBe(false)
  })

  test('non-object JSON and read errors count as corrupt', () => {
    for (const bad of ['null', '[1,2]', '"x"']) {
      const r = createAccessReader(() => bad, () => {})
      expect(r.load().dmPolicy).toBe('disabled')
    }
    const r = createAccessReader(() => {
      throw new Error('EACCES')
    }, () => {})
    expect(r.load().dmPolicy).toBe('disabled')
    expect(r.lastReadOk()).toBe(false)
  })
})

describe('chunk', () => {
  test('short text is one chunk', () => {
    expect(chunk('abc', 10, 'length')).toEqual(['abc'])
  })

  test('length mode cuts hard', () => {
    expect(chunk('abcdefghij', 4, 'length')).toEqual(['abcd', 'efgh', 'ij'])
  })

  test('newline mode prefers paragraph boundaries', () => {
    const text = 'para one is here\n\npara two is here'
    expect(chunk(text, 20, 'newline')).toEqual(['para one is here', 'para two is here'])
  })

  test('newline mode falls back to spaces, then hard cut', () => {
    expect(chunk('aaaa bbbb cccc', 10, 'newline')).toEqual(['aaaa bbbb', ' cccc'])
    expect(chunk('x'.repeat(25), 10, 'newline')).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })
})

describe('misc', () => {
  test('approval codes are 5 letters of [a-km-z] and avoid taken codes', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = newApprovalCode(x => taken.has(x))
      expect(c).toMatch(/^[a-km-z]{5}$/)
      expect(taken.has(c)).toBe(false)
      taken.add(c)
    }
  })

  test('noteBounded drops the oldest past the cap', () => {
    const s = new Set<string>()
    for (const v of ['a', 'b', 'c', 'd']) noteBounded(s, v, 3)
    expect([...s]).toEqual(['b', 'c', 'd'])
  })
})
