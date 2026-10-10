import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'statusband',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// A weekday noon, local time: inside work hours, so pace colors are not forced red.
const NOW = new Date(2026, 9, 7, 12, 0).getTime()

test('draws on both surfaces before any data arrives', async ($, on) => {
  mock.clock(on, { now: NOW })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    await ui.unmount()
  }
})

test('toasts once each time the context fill crosses 60% upward', async ($, on) => {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', ($, e: any) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  // Beneath the plugin, the engine's echo of the measurement.
  on('session.measure', ($, e) => ({ changed: e.changed }))
  for (const percent of [50, 63, 70, 40, 65]) {
    await $.session.measure({
      context: { tokens: percent * 2000, window: 200000, percent },
      rateLimits: [],
      changed: ['context'],
    } as any)
  }
  expect(toasts).toEqual(['Context window at 63% (126k/200k)', 'Context window at 65% (130k/200k)'])
})

test('/clear drops the old conversation\'s cache figures; other endings keep them', async ($, on) => {
  mock.clock(on, { now: NOW })
  const cleared: string[] = []
  on('state.set', ($, e: any, next) => {
    if (e.plugin === 'statusband' && e.value === null) cleared.push(e.key)
    return next(e)
  })
  // Beneath the plugin, the engine's end step.
  on('session.end', () => ({ sessionId: 's' }) as any)

  await $.session.end({ reason: 'other' } as any)
  expect(cleared).toEqual([])
  await $.session.end({ reason: 'clear' } as any)
  expect(cleared.sort()).toEqual(['cacheExpiresAt', 'cacheHit', 'cacheTtlMs', 'cacheWarnedFor'])
})

test('a compaction shows its new size at once; a precompute does not', async ($, on) => {
  mock.clock(on, { now: NOW })
  const contexts: any[] = []
  on('state.set', ($, e: any, next) => {
    if (e.plugin === 'statusband' && e.key === 'context') contexts.push(e.value)
    return next(e)
  })
  // Beneath the plugin: the window, and the engine's compaction step.
  // (An op's hook answers `{ value }`, as state.get's does.)
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }) as any)
  const messages = [{ role: 'user', text: 'the summary', toolUses: [] }]
  on('session.compact', () => ({ messages, tokensBefore: 150000, tokensAfter: 30000 }) as any)

  await $.session.compact({ trigger: 'precompute', messages } as any)
  expect(contexts).toEqual([])
  await $.session.compact({ trigger: 'manual', messages } as any)
  expect(contexts).toEqual([{ tokens: 30000, window: 200000, percent: 15 }])
})

test('5h/7d readings are shared with the account\'s other sessions', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // The env names another account (as a `claude` run with the app's identity env
  // leaves ~/.claude.json): the key follows the credential's profile instead.
  mock.env(on, { CLAUDE_CODE_ACCOUNT_UUID: 'not-this-one' })
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'oauth' } }) as any)
  on('http.fetch', ($, e: any) =>
    ({
      value: e.url.endsWith('/api/oauth/profile')
        ? { ok: true, status: 200, text: JSON.stringify({ account: { uuid: 'acct' } }) }
        : { ok: false, status: 503, text: '' },
    }) as any,
  )
  const five = (percentUsed: number) => [{ kind: 'five_hour', percentUsed, resetsAt: new Date(NOW + 3600_000).toISOString() }]
  // The plugin's store, which the account's other sessions write too; one of
  // them already shared a reading.
  const store = new Map<string, unknown>([['rates:acct', { rates: five(40), at: NOW - 60_000 }]])
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as any)
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }) as any)
  const shown: unknown[] = []
  on('state.set', ($, e: any, next) => {
    if (e.plugin === 'statusband' && e.key === 'rates') shown.push(e.value)
    return next(e)
  })
  // Beneath the plugin: the engine's start, its usage (a stale start-up
  // reading), the echo of a measurement, and what the rest of the start reads.
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: five(82) } }) as any)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.288' } }) as any)
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as any)

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  // The start-up 82% gives way to the shared 40%.
  expect(shown.at(-1)).toEqual(five(40))

  // A newer reading from elsewhere is taken on the next tick.
  store.set('rates:acct', { rates: five(55), at: NOW + 30_000 })
  await clock.advance(60_000)
  expect(shown.at(-1)).toEqual(five(55))

  // This session's own turn reads 60%: shown, and shared.
  await $.session.measure({ context: { window: 200000 }, rateLimits: five(60), changed: ['rateLimits'] } as any)
  expect(shown.at(-1)).toEqual(five(60))
  expect(store.get('rates:acct')).toEqual({ rates: five(60), at: NOW + 60_000 })

  // An older shared reading never replaces a newer one of its own.
  store.set('rates:acct', { rates: five(50), at: NOW + 45_000 })
  await clock.advance(60_000)
  expect(shown.at(-1)).toEqual(five(60))
})

test('a newer installed version gets one toast of its CHANGELOG, CLI only, once it has a section', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as any)
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }) as any)
  const toasts: string[] = []
  on('ui.toast', ($, e: any) => (toasts.push(e.text), { value: undefined }) as any)
  on('ui.log', () => ({ value: undefined }) as any)
  // Beneath the plugin: 2.1.288 runs, 2.1.293 is installed beside it.
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.288' } }) as any)
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('session.root', () => ({ value: '/tmp' }) as any)
  on('session.authorize', () => ({ value: null }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as any)
  on('fs.exists', ($, e: any) => ({ value: e.path === '/home/me/.local/share/claude/versions' }) as any)
  on('fs.list', () => ({ value: [{ name: '2.1.288' }, { name: '2.1.293' }] }) as any)
  let changelog = '# Changelog\n\n## 2.1.292\n\n- Fixed an older thing\n'
  on('http.fetch', ($, e: any) =>
    ({ value: e.url.endsWith('/CHANGELOG.md') ? { ok: true, status: 200, text: changelog } : { ok: false, status: 503, text: '' } }) as any,
  )
  const asked: string[] = []
  on('model.complete', ($, e: any) => (asked.push(e.prompt), { value: { isAnswered: true, text: '• 新增 Haiku 5.5\n• 修复内存泄漏', usage: {} } }) as any)

  // The desktop never asks.
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  expect(asked).toEqual([])

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  // No section for 2.1.293 yet: no summary, no toast.
  expect(asked).toEqual([])
  expect(toasts).toEqual([])

  // It appears; the next try (after the retry wait) summarises that section alone.
  changelog = '# Changelog\n\n## 2.1.293\n\n- Added Claude Haiku 5.5\n- Fixed a memory leak\n\n## 2.1.292\n\n- Fixed an older thing\n'
  await clock.advance(1800_000 + 60_000)
  expect(asked).toEqual(['Claude Code 2.1.293 CHANGELOG:\n\n- Added Claude Haiku 5.5\n- Fixed a memory leak'])
  expect(toasts).toEqual(['Claude Code 2.1.293\n• 新增 Haiku 5.5\n• 修复内存泄漏'])

  // Once per version: later ticks stay quiet.
  await clock.advance(1800_000 + 60_000)
  expect(toasts).toHaveLength(1)
})

test('a rate-limited Fable fetch keeps the shared reading and waits as told', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // The account's other sessions read 30% an hour ago; this one has none yet.
  mock.env(on, {})
  const store = new Map<string, unknown>([['fable:acct', { pct: 30, fetchedAt: NOW - 3600_000, attemptedAt: NOW - 600_000 }]])
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as any)
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }) as any)
  on('ui.log', () => ({ value: undefined }) as any)
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.295' } }) as any)
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as any)
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'oauth' } }) as any)
  let usageCalls = 0
  on('http.fetch', ($, e: any) => {
    if (e.url.endsWith('/api/oauth/profile')) return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ account: { uuid: 'acct' } }) } } as any
    usageCalls++
    return { value: { ok: false, status: 429, headers: { 'Retry-After': '1200' }, text: '{"error":{}}' } } as any
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await clock.advance(1000) // the start's fetch runs unawaited; let it land
  expect(usageCalls).toBe(1)
  // The 429 neither blanks the account's reading nor goes unheeded.
  expect(store.get('fable:acct')).toMatchObject({ pct: 30, fetchedAt: NOW - 3600_000, retryAt: NOW + 1200_000 })

  // Inside the 20 minutes asked: no more requests, past the usual 5-minute TTL too.
  await clock.advance(15 * 60_000)
  expect(usageCalls).toBe(1)
  await clock.advance(6 * 60_000)
  expect(usageCalls).toBe(2)
})

test('/cd refreshes the directory and its git at once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const set: Record<string, unknown> = {}
  on('state.set', ($, e: any, next) => {
    if (e.plugin === 'statusband') set[e.key] = e.value
    return next(e)
  })
  // Beneath the plugin: the engine's /cd, and the session then running in the
  // new directory, a repo on `dev`.
  on('command.run', () => ({ text: '' }))
  on('session.cwd', () => ({ value: '/work/other' }) as any)
  on('process.run', ($, e: any) =>
    ({ value: { exitCode: 0, stdout: e.argv[1] === 'branch' ? 'dev\n' : ' 2 files changed, 5 insertions(+)\n', stderr: '' } }) as any,
  )

  await $.command.run({ command: 'cd', args: '/work/other' } as any)
  // The refresh runs after the command settles; let it (well inside a tick).
  await clock.advance(1000)
  expect(set.cwd).toBe('/work/other')
  expect(set.git).toEqual({ branch: 'dev', files: 2, add: 5, del: 0 })
})

test('draws every segment on both surfaces once the data is in', async ($, on) => {
  mock.clock(on, { now: NOW })
  const iso = (ms: number) => new Date(ms).toISOString()
  const values: Record<string, unknown> = {
    rates: [
      { kind: 'five_hour', percentUsed: 27, resetsAt: iso(NOW + 2 * 3600_000) },
      { kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 3 * 86400_000) },
    ],
    cacheHit: 99,
    cacheExpiresAt: NOW + 1800_000,
    git: { branch: 'main', files: 6, add: 272, del: 113 },
    cwd: '/Users/someone/claude-utils',
    cost: { session: 3.42, today: 50.1, month: 1100 },
    fable: { pct: 67, fetchedAt: NOW, attemptedAt: NOW },
    model: 'Opus 5.5',
    version: { current: '2.1.286', latest: '2.1.289' },
    context: { tokens: 70000, window: 200000, percent: 35 },
  }
  // Beneath the plugin, answer its state reads with the session's figures.
  // A state.get hook answers `{ value: StateRead }`, the read itself wrapped.
  on('state.get', ($, e: any, next) =>
    e.plugin === 'statusband' && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e),
  )

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.findAll({ type: 'Raster' })).toHaveLength(3)
  expect(await term.find({ type: 'Text', text: /fb67%/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /↑/ })).toBeDefined()
  // The directory is a file: link (cmd+click opens it in Finder), as statusline.sh's OSC 8 one.
  expect(await term.find({ type: 'Markdown', text: /\[claude-utils\]\(file:\/\/\/Users\/someone\/claude-utils\)/ })).toBeDefined()
  await term.unmount()

  // A 91-column terminal: line 2 is 93 cells wide in full, so the context
  // token counts go first and every bar still shows (nothing wraps).
  const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 91 } })
  expect(await narrow.findAll({ type: 'Raster' })).toHaveLength(3)
  expect(await narrow.find({ type: 'Text', text: /70k\/200k/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /3d0h/ })).toBeDefined()
  await narrow.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // 5 line icons (folder, branch, cache, warm, cost) + the context, 5h and 7d
  // bars + 5 group dividers (3 on line 1, 2 on line 2).
  expect(await desk.findAll({ type: 'Svg' })).toHaveLength(13)
  expect(await desk.find({ type: 'Text', text: /^70k\/200k$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /fb 67%/ })).toBeDefined()
  await desk.unmount()
})
