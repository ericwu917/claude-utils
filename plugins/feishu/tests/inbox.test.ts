import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FILE_NAME_MAX_CHARS,
  imageExt,
  inboxFileName,
  isInboxChild,
  messageResources,
  parseContent,
  resourceErrorText,
  sanitizeFileName,
  type InboundResource,
} from '../lib.ts'
import { cleanInbox, downloadResources, prepareInbox, type FetchedResource } from '../inbox.ts'
import { BOT, botMention, userMention } from './fixtures.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const GIF = new TextEncoder().encode('GIF89a......')
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50])

const post = (content: unknown[][], title?: string) => JSON.stringify({ ...(title ? { title } : {}), content })

describe('messageResources', () => {
  test('image message → one image', () => {
    expect(messageResources('image', '{"image_key":"img_v3_abc-1"}')).toEqual([{ kind: 'image', key: 'img_v3_abc-1', n: 1 }])
  })

  test('post: images in order of appearance, among text and @', () => {
    const c = post([
      [{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: '看图' }, { tag: 'img', image_key: 'img_a' }],
      [{ tag: 'img', image_key: 'img_b' }, { tag: 'media', file_key: 'file_m', image_key: 'img_cover' }],
      [{ tag: 'text', text: '还有' }, { tag: 'img', image_key: 'img_c' }],
    ])
    expect(messageResources('post', c)).toEqual([
      { kind: 'image', key: 'img_a', n: 1 },
      { kind: 'image', key: 'img_b', n: 2 },
      { kind: 'image', key: 'img_c', n: 3 },
    ])
  })

  test('file message → one file with its cleaned name', () => {
    expect(messageResources('file', '{"file_key":"file_v3_x","file_name":"../报错 日志.har"}')).toEqual([
      { kind: 'file', key: 'file_v3_x', n: 1, name: '_报错_日志.har' },
    ])
    expect(messageResources('file', '{"file_key":"file_v3_x"}')).toEqual([{ kind: 'file', key: 'file_v3_x', n: 1 }])
  })

  test('media, audio, sticker, cards and bad JSON → nothing', () => {
    expect(messageResources('media', '{"file_key":"file_m","image_key":"img_cover"}')).toEqual([])
    expect(messageResources('audio', '{"file_key":"file_a"}')).toEqual([])
    expect(messageResources('sticker', '{"file_key":"file_s"}')).toEqual([])
    expect(messageResources('interactive', '{"image_key":"img_x"}')).toEqual([])
    expect(messageResources('image', '{not json')).toEqual([])
    expect(messageResources('post', '{not json')).toEqual([])
  })

  test('missing or path-like keys are not resources', () => {
    expect(messageResources('image', '{}')).toEqual([])
    expect(messageResources('image', '{"image_key":"../../open-apis/x"}')).toEqual([])
    expect(messageResources('file', '{"file_key":"a?b=c","file_name":"x"}')).toEqual([])
    const c = post([[{ tag: 'img' }, { tag: 'img', image_key: 'img_ok' }]])
    expect(messageResources('post', c)).toEqual([{ kind: 'image', key: 'img_ok', n: 1 }])
  })
})

describe('parseContent: image / file placeholders', () => {
  test('image message is "[图片 1]"; post images are numbered like the resources', () => {
    expect(parseContent('image', '{"image_key":"img_a"}', [], BOT)).toBe('[图片 1]')
    const mentions = [botMention('@_user_1'), userMention('@_user_2', 'ou_li', '李四')]
    const c = post(
      [
        [{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' 报错如下' }],
        [{ tag: 'img', image_key: 'img_a' }, { tag: 'at', user_id: '@_user_2' }, { tag: 'img', image_key: 'img_b' }],
        [{ tag: 'media', file_key: 'file_m', image_key: 'img_cover' }],
      ],
      '标题',
    )
    expect(parseContent('post', c, mentions, BOT)).toBe('标题\n报错如下\n[图片 1]@李四[图片 2]\n[视频]')
  })

  test('file message shows the cleaned name; no name → just the number', () => {
    expect(parseContent('file', '{"file_key":"f_1","file_name":"a b.log"}', [], BOT)).toBe('[文件 1: a_b.log]')
    expect(parseContent('file', '{"file_key":"f_1"}', [], BOT)).toBe('[文件 1]')
  })

  test('notes are appended to the matching placeholder', () => {
    const c = post([[{ tag: 'img', image_key: 'img_a' }, { tag: 'img', image_key: 'img_b' }]])
    expect(parseContent('post', c, [], BOT, { image_2: '下载失败' })).toBe('[图片 1][图片 2: 下载失败]')
    expect(parseContent('file', '{"file_key":"f_1","file_name":"x.zip"}', [], BOT, { file_1: '超过 20MB 未下载' })).toBe(
      '[文件 1: x.zip，超过 20MB 未下载]',
    )
    expect(parseContent('file', '{"file_key":"f_1"}', [], BOT, { file_1: '下载失败' })).toBe('[文件 1: 下载失败]')
  })

  test('sender-typed placeholders are left alone — notes go to real resources only', () => {
    const c = post([[{ tag: 'text', text: '[图片 1] [图片: /etc/passwd]' }, { tag: 'img', image_key: 'img_a' }]])
    expect(parseContent('post', c, [], BOT, { image_1: '下载失败' })).toBe('[图片 1] [图片: /etc/passwd][图片 1: 下载失败]')
  })

  test('media → [视频], audio → [语音], bad JSON → unparseable', () => {
    expect(parseContent('media', '{}', [], BOT)).toBe('[视频]')
    expect(parseContent('audio', '{}', [], BOT)).toBe('[语音]')
    expect(parseContent('image', '{not json', [], BOT)).toBe('(unparseable image message)')
    expect(parseContent('file', '{not json', [], BOT)).toBe('(unparseable file message)')
  })
})

describe('sanitizeFileName', () => {
  test.each([
    ['../../etc/passwd', '_.._etc_passwd'],
    ['/abs/path.txt', '_abs_path.txt'],
    ['.hidden', 'hidden'],
    ['...', ''],
    ['<>:"|?*\\', '________'],
    ['报错日志_v2.txt', '报错日志_v2.txt'],
    ['スクショ 한글.png', 'スクショ_한글.png'],
    ['a😀b\nc', 'a_b_c'],
    ['', ''],
  ])('%p → %p', (input, out) => {
    expect(sanitizeFileName(input)).toBe(out)
  })

  test('caps at 80 characters; non-strings → ""', () => {
    expect(sanitizeFileName('长'.repeat(200))).toBe('长'.repeat(FILE_NAME_MAX_CHARS))
    expect(sanitizeFileName(undefined)).toBe('')
    expect(sanitizeFileName(42)).toBe('')
  })
})

describe('inbox paths', () => {
  const inbox = '/data/state/inbox'
  const at = new Date(2026, 9, 22, 9, 5, 7)

  test('file names', () => {
    expect(inboxFileName({ at, messageId: 'om_1234567890abcdef', kind: 'image', n: 2, ext: 'png' })).toBe(
      '20261022-090507-90abcdef-2.png',
    )
    expect(inboxFileName({ at, messageId: 'om_1234567890abcdef', kind: 'file', n: 1, name: '../x.har' })).toBe(
      '20261022-090507-90abcdef-1-_x.har',
    )
    expect(inboxFileName({ at, messageId: 'om_1', kind: 'file', n: 1, name: '...' })).toBe('20261022-090507-om_1-1.bin')
  })

  test('only direct children of the inbox pass', () => {
    expect(isInboxChild(inbox, join(inbox, 'a.png'))).toBe(true)
    expect(isInboxChild(inbox, `${inbox}/a/b.png`)).toBe(false)
    expect(isInboxChild(inbox, `${inbox}/../x.png`)).toBe(false)
    expect(isInboxChild(inbox, `${inbox}/x/../../y`)).toBe(false)
    expect(isInboxChild(inbox, inbox)).toBe(false)
    expect(isInboxChild(inbox, `${inbox}/.`)).toBe(false)
    expect(isInboxChild(inbox, '/etc/passwd')).toBe(false)
    expect(isInboxChild(inbox, 'relative.png')).toBe(false)
    const hostile = inboxFileName({ at, messageId: '../../om', kind: 'file', n: 1, name: '../../../../etc/cron.d/x' })
    expect(isInboxChild(inbox, join(inbox, hostile))).toBe(true)
  })
})

describe('imageExt', () => {
  const none = new Uint8Array()
  test('Content-Type first', () => {
    expect(imageExt('image/png', none)).toBe('png')
    expect(imageExt('image/jpeg; charset=binary', none)).toBe('jpg')
    expect(imageExt('IMAGE/GIF', none)).toBe('gif')
    expect(imageExt('image/webp', none)).toBe('webp')
  })

  test('then magic bytes, then bin', () => {
    expect(imageExt('application/octet-stream', PNG)).toBe('png')
    expect(imageExt(undefined, JPG)).toBe('jpg')
    expect(imageExt('', GIF)).toBe('gif')
    expect(imageExt(undefined, WEBP)).toBe('webp')
    expect(imageExt('image/x-unknown', new Uint8Array([1, 2, 3]))).toBe('bin')
    expect(imageExt(undefined, new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBe('bin')
  })
})

describe('resourceErrorText', () => {
  test('Feishu code from a raw error body', () => {
    const body = JSON.stringify({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:message:readonly]' })
    expect(resourceErrorText({ status: 400, body, message: 'Request failed with status code 400' }, [])).toBe(
      'feishu api error 99991672: Access denied. One of the following scopes is required: [im:message:readonly]',
    )
  })

  test('no code → message + HTTP status; credentials redacted', () => {
    expect(resourceErrorText({ status: 502, body: '<html>', message: 'Request failed' }, [])).toBe('Request failed (HTTP 502)')
    expect(resourceErrorText({ message: 'boom Bearer t-abcdefghijklmnop sec_123' }, ['sec_123'])).toBe(
      'boom [REDACTED] [REDACTED]',
    )
  })
})

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-inbox-test-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('prepareInbox', () => {
  test('creates <realpath(state)>/inbox with 0700, through a symlinked state dir', () => {
    const real = join(dir, 'real-state')
    mkdirSync(real)
    const link = join(dir, 'link-state')
    symlinkSync(real, link)
    const inbox = prepareInbox(link)
    expect(inbox).toBe(join(real, 'inbox'))
    expect(statSync(inbox).mode & 0o777).toBe(0o700)
  })

  test('refuses an inbox that is a symlink', () => {
    const state = join(dir, 'state')
    mkdirSync(state)
    mkdirSync(join(dir, 'elsewhere'))
    symlinkSync(join(dir, 'elsewhere'), join(state, 'inbox'))
    expect(() => prepareInbox(state)).toThrow('not a directory')
  })
})

describe('cleanInbox', () => {
  test('deletes only regular files older than 7 days, not recursively, never through symlinks', () => {
    const now = Date.now()
    const old = (now - 8 * 24 * 3600 * 1000) / 1000
    const recent = (now - 6 * 24 * 3600 * 1000) / 1000
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'keep')
    utimesSync(outside, old, old)
    const inbox = join(dir, 'inbox')
    mkdirSync(inbox)
    writeFileSync(join(inbox, 'old.png'), 'x')
    utimesSync(join(inbox, 'old.png'), old, old)
    writeFileSync(join(inbox, 'recent.png'), 'x')
    utimesSync(join(inbox, 'recent.png'), recent, recent)
    symlinkSync(outside, join(inbox, 'link'))
    lutimesSync(join(inbox, 'link'), old, old)
    mkdirSync(join(inbox, 'sub'))
    writeFileSync(join(inbox, 'sub', 'deep-old.png'), 'x')
    utimesSync(join(inbox, 'sub', 'deep-old.png'), old, old)
    utimesSync(join(inbox, 'sub'), old, old)

    expect(cleanInbox(inbox, now, () => {})).toBe(1)
    expect(readdirSync(inbox).sort()).toEqual(['link', 'recent.png', 'sub'])
    expect(readFileSync(outside, 'utf8')).toBe('keep')
    expect(existsSync(join(inbox, 'sub', 'deep-old.png'))).toBe(true)
  })

  test('missing dir → 0, logged', () => {
    const logs: string[] = []
    expect(cleanInbox(join(dir, 'nope'), Date.now(), m => logs.push(m))).toBe(0)
    expect(logs).toHaveLength(1)
  })
})

// A fake response body: yields `chunks`, or hangs after them with `hang`.
function fakeStream(chunks: Uint8Array[], opts: { hang?: boolean } = {}) {
  const state = { destroyed: false, wake: () => {} }
  async function* gen() {
    for (const c of chunks) {
      if (state.destroyed) throw new Error('destroyed')
      yield c
    }
    if (opts.hang) {
      await new Promise<void>(res => {
        state.wake = res
      })
      throw new Error('destroyed')
    }
  }
  const stream = Object.assign(gen(), {
    destroy: () => {
      state.destroyed = true
      state.wake()
    },
  })
  return { stream, state }
}

describe('downloadResources', () => {
  const at = new Date(2026, 9, 22, 9, 5, 7)
  const img = (n: number): InboundResource => ({ kind: 'image', key: `img_${n}`, n })

  function opts(inbox: string | undefined, fetch: (r: InboundResource, s: AbortSignal) => Promise<FetchedResource>) {
    const logs: string[] = []
    return {
      logs,
      o: { inbox, messageId: 'om_1234567890abcdef', at, fetch, log: (m: string) => logs.push(m), timeoutMs: 200 },
    }
  }

  test('success: images by magic number, a file by its name; 0600, content intact', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const bodies: Record<string, Uint8Array[]> = {
      img_1: [PNG.subarray(0, 5), PNG.subarray(5)], // magic split across chunks
      img_2: [JPG],
      file_x: [new TextEncoder().encode('log line\n')],
    }
    const { o, logs } = opts(inbox, async r => ({ stream: fakeStream(bodies[r.key]!).stream }))
    const res = await downloadResources([img(1), img(2), { kind: 'file', key: 'file_x', n: 1, name: 'app.log' }], o)
    expect(res.notes).toEqual({})
    expect(logs).toEqual([])
    expect(res.meta).toEqual({
      image_1: join(inbox, '20261022-090507-90abcdef-1.png'),
      image_2: join(inbox, '20261022-090507-90abcdef-2.jpg'),
      file_1: join(inbox, '20261022-090507-90abcdef-1-app.log'),
    })
    expect(new Uint8Array(readFileSync(res.meta.image_1!))).toEqual(PNG)
    expect(readFileSync(res.meta.file_1!, 'utf8')).toBe('log line\n')
    expect(statSync(res.meta.image_1!).mode & 0o777).toBe(0o600)
  })

  test('Content-Type wins over magic; unknown → .bin', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const { o } = opts(inbox, async r =>
      r.n === 1
        ? { stream: fakeStream([PNG]).stream, contentType: 'image/webp' }
        : { stream: fakeStream([new Uint8Array([1, 2, 3])]).stream },
    )
    const res = await downloadResources([img(1), img(2)], o)
    expect(res.meta.image_1!.endsWith('-1.webp')).toBe(true)
    expect(res.meta.image_2!.endsWith('-2.bin')).toBe(true)
  })

  test('failure: no meta, a note, the error logged; the other resources unaffected', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const { o, logs } = opts(inbox, async r => {
      if (r.n === 2) throw new Error('feishu api error 99991672: scope missing')
      return { stream: fakeStream([PNG]).stream }
    })
    const resources = [img(1), img(2)]
    const res = await downloadResources(resources, o)
    expect(Object.keys(res.meta)).toEqual(['image_1'])
    expect(res.notes).toEqual({ image_2: '下载失败' })
    expect(logs).toEqual(['image_2 of om_1234567890abcdef not downloaded: feishu api error 99991672: scope missing'])
    const c = post([[{ tag: 'img', image_key: 'img_1' }, { tag: 'img', image_key: 'img_2' }]])
    expect(parseContent('post', c, [], BOT, res.notes)).toBe('[图片 1][图片 2: 下载失败]')
  })

  test('too large while streaming: stopped, half file deleted, note says the cap in force', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const big = fakeStream([PNG, new Uint8Array(40), new Uint8Array(40)])
    const { o } = opts(inbox, async () => ({ stream: big.stream }))
    const res = await downloadResources([{ kind: 'file', key: 'file_x', n: 1, name: 'x.zip' }], { ...o, maxFileBytes: 50 })
    expect(res.meta).toEqual({})
    expect(res.notes).toEqual({ file_1: '超过 50B 未下载' })
    expect(big.state.destroyed).toBe(true)
    expect(readdirSync(inbox)).toEqual([])
    expect(parseContent('file', '{"file_key":"file_x","file_name":"x.zip"}', [], BOT, res.notes)).toBe(
      '[文件 1: x.zip，超过 50B 未下载]',
    )
  })

  test('too large at the production cap: 20MB file streamed in 1MB chunks', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const mb = new Uint8Array(1024 * 1024)
    const big = fakeStream(Array.from({ length: 21 }, () => mb))
    const { o } = opts(inbox, async () => ({ stream: big.stream }))
    const res = await downloadResources([{ kind: 'file', key: 'file_x', n: 1, name: 'x.zip' }], o)
    expect(res.notes).toEqual({ file_1: '超过 20MB 未下载' })
    expect(readdirSync(inbox)).toEqual([])
  })

  test('over-count note uses the count in force', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const { o } = opts(inbox, async () => ({ stream: fakeStream([PNG]).stream }))
    const res = await downloadResources([img(1), img(2), img(3)], { ...o, maxCount: 2 })
    expect(res.notes).toEqual({ image_3: '超过 2 个未下载' })
  })

  test('too large by Content-Length: not read at all', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const s = fakeStream([PNG])
    const { o } = opts(inbox, async () => ({ stream: s.stream, contentLength: 11 * 1024 * 1024 }))
    const res = await downloadResources([img(1)], o)
    expect(res.notes).toEqual({ image_1: '超过 10MB 未下载' })
    expect(s.state.destroyed).toBe(true)
    expect(readdirSync(inbox)).toEqual([])
  })

  test('over the count: only the first 9 are fetched, the rest get a note', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const fetched: string[] = []
    const { o } = opts(inbox, async r => {
      fetched.push(r.key)
      return { stream: fakeStream([PNG]).stream }
    })
    const res = await downloadResources(Array.from({ length: 11 }, (_, i) => img(i + 1)), o)
    expect(fetched).toHaveLength(9)
    expect(Object.keys(res.meta)).toHaveLength(9)
    expect(res.meta.image_9).toBeDefined()
    expect(res.notes).toEqual({ image_10: '超过 9 个未下载', image_11: '超过 9 个未下载' })
  })

  test('timeout mid-stream: failed, stream stopped, partial file removed', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const s = fakeStream([PNG], { hang: true })
    const { o, logs } = opts(inbox, async () => ({ stream: s.stream }))
    const res = await downloadResources([img(1)], { ...o, timeoutMs: 50 })
    expect(res.meta).toEqual({})
    expect(res.notes).toEqual({ image_1: '下载失败' })
    expect(logs[0]).toContain('timed out')
    expect(s.state.destroyed).toBe(true)
    await Bun.sleep(20)
    expect(readdirSync(inbox)).toEqual([])
  })

  test('timeout before the response: a late body is dropped, no file left', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const s = fakeStream([PNG])
    const { o } = opts(inbox, async () => {
      await Bun.sleep(100)
      return { stream: s.stream }
    })
    const res = await downloadResources([img(1)], { ...o, timeoutMs: 30 })
    expect(res.notes).toEqual({ image_1: '下载失败' })
    await Bun.sleep(120)
    expect(s.state.destroyed).toBe(true)
    expect(readdirSync(inbox)).toEqual([])
  })

  test('no inbox: every resource fails, nothing fetched', async () => {
    let calls = 0
    const { o } = opts(undefined, async () => {
      calls++
      return { stream: fakeStream([PNG]).stream }
    })
    const res = await downloadResources([img(1)], o)
    expect(calls).toBe(0)
    expect(res.notes).toEqual({ image_1: '下载失败' })
  })

  test('an existing file is never overwritten', async () => {
    const inbox = prepareInbox(join(dir, 'state'))
    const taken = join(inbox, '20261022-090507-90abcdef-1.png')
    writeFileSync(taken, 'mine')
    const { o } = opts(inbox, async () => ({ stream: fakeStream([PNG]).stream }))
    const res = await downloadResources([img(1)], o)
    expect(res.notes).toEqual({ image_1: '下载失败' })
    expect(readFileSync(taken, 'utf8')).toBe('mine')
  })
})
