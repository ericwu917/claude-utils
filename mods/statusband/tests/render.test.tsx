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
  expect(cleared.sort()).toEqual(['cacheExpiresAt', 'cacheHit', 'cacheTtlMs', 'cacheWarnedFor', 'taskStartedAt'])
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

test('the plan tier comes from the credential\'s profile and follows a re-login', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
  let rateLimitTier = 'default_claude_max_20x'
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'oauth' } }) as any)
  on('http.fetch', ($, e: any) =>
    ({
      value: e.url.endsWith('/api/oauth/profile')
        ? { ok: true, status: 200, text: JSON.stringify({ account: { uuid: 'acct' }, organization: { rate_limit_tier: rateLimitTier } }) }
        : { ok: false, status: 503, text: '' },
    }) as any,
  )
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  const tiers: unknown[] = []
  on('state.set', ($, e: any, next) => {
    if (e.plugin === 'statusband' && e.key === 'tier') tiers.push(e.value)
    return next(e)
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.288' } }) as any)
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as any)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  expect(tiers.at(-1)).toBe('20x')

  // A /login to a Pro account: the next ask of the profile drops the tier.
  rateLimitTier = 'default_claude_pro'
  await clock.advance(11 * 60_000)
  expect(tiers.at(-1)).toBeNull()
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

test('a window past its reset with no newer reading draws as started over', async ($, on) => {
  mock.clock(on, { now: NOW })
  const iso = (ms: number) => new Date(ms).toISOString()
  // 5h lapsed a minute ago at 82%; 7d still runs.
  const values: Record<string, unknown> = {
    rates: [
      { kind: 'five_hour', percentUsed: 82, resetsAt: iso(NOW - 60_000) },
      { kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 3 * 86400_000) },
    ],
  }
  on('state.get', ($, e: any, next) =>
    e.plugin === 'statusband' && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e),
  )

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: / 82%/ })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /^ 0%$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /\(--\)/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: / 30%/ })).toBeDefined()
  // The empty bar still draws (ctx, 5h, 7d): the tree validated whole.
  expect(await term.findAll({ type: 'Raster' })).toHaveLength(3)
  await term.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: /^0%$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^--$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^30%$/ })).toBeDefined()
  await desk.unmount()

  // 7d lapsed too, and Fable last read before that reset: its 70% belongs to
  // the week that ended, so no fb figure until the next fetch.
  values.rates = [
    { kind: 'five_hour', percentUsed: 82, resetsAt: iso(NOW - 60_000) },
    { kind: 'seven_day', percentUsed: 90, resetsAt: iso(NOW - 120_000) },
  ]
  values.fable = { pct: 70, fetchedAt: NOW - 600_000, attemptedAt: NOW - 60_000 }
  const term2 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term2.find({ type: 'Text', text: /fb70%/ })).toBeUndefined()
  expect(await term2.find({ type: 'Text', text: / 90%/ })).toBeUndefined()
  expect(await term2.findAll({ type: 'Raster' })).toHaveLength(3)
  await term2.unmount()
  const desk2 = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desk2.find({ type: 'Text', text: /fb 70%/ })).toBeUndefined()
  await desk2.unmount()

  // A Fable reading taken after the reset is the new week's: shown.
  values.fable = { pct: 3, fetchedAt: NOW - 30_000, attemptedAt: NOW - 30_000 }
  const term3 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term3.find({ type: 'Text', text: /fb3%/ })).toBeDefined()
  await term3.unmount()
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
    tier: '20x',
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
  expect(await term.find({ type: 'Text', text: /^20x$/ })).toBeDefined()
  // The directory is a file: link (cmd+click opens it in Finder), as statusline.sh's OSC 8 one.
  expect(await term.find({ type: 'Markdown', text: /\[claude-utils\]\(file:\/\/\/Users\/someone\/claude-utils\)/ })).toBeDefined()
  await term.unmount()

  // A 91-column terminal: line 2 is 99 cells wide in full, so the context
  // token counts go first and every bar still shows (nothing wraps).
  const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 91 } })
  expect(await narrow.findAll({ type: 'Raster' })).toHaveLength(3)
  expect(await narrow.find({ type: 'Text', text: /70k\/200k/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /3d0h/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /^20x$/ })).toBeDefined()
  await narrow.unmount()

  // 20x and 5x draw in different colors.
  const tierColor = async (t: string) => {
    values.tier = t
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const color = (await ui.find({ type: 'Text', text: new RegExp(`^${t}$`) }))?.props.color
    await ui.unmount()
    return color
  }
  const [c20, c5] = [await tierColor('20x'), await tierColor('5x')]
  expect(c20).toBeDefined()
  expect(c5).toBeDefined()
  expect(c5).not.toBe(c20)
  values.tier = '20x'

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // 5 line icons (folder, branch, cache, warm, cost) + the context, 5h and 7d
  // bars + 5 group dividers (3 on line 1, 2 on line 2).
  expect(await desk.findAll({ type: 'Svg' })).toHaveLength(13)
  expect(await desk.find({ type: 'Text', text: /^70k\/200k$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /fb 67%/ })).toBeDefined()
  await desk.unmount()
})

// Beneath the plugin for the long-task notice: the turn, and a Discord webhook
// file whose posts are kept.
function taskKit(on: any, clock: any, env: Record<string, string> = {}) {
  mock.env(on, { HOME: '/home/me', ...env })
  on('ui.log', () => ({ value: undefined }) as any)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}) as any)
  const kit = {
    files: new Set(['/home/me/.config/discord-webhook']),
    posted: [] as string[],
    async turn() {
      await kit.$.turn.start({ text: '', turnId: 't' })
    },
    async stop(after: number, background: number, last = 'All **done**') {
      await clock.advance(after)
      await kit.$.classic.Stop({ stop_hook_active: false, last_assistant_message: last, background_tasks: Array.from({ length: background }, (_, i) => ({ id: `b${i}`, type: 'subagent', status: 'running', description: 'x' })) } as any)
      await clock.advance(1000) // the notice goes out unawaited; let it land
    },
    $: null as any,
  }
  on('fs.exists', ($: any, e: any) => ({ value: kit.files.has(e.path) }) as any)
  on('fs.read', () => ({ value: 'https://discord.example/hook\n' }) as any)
  on('http.fetch', ($: any, e: any) => (kit.posted.push(JSON.parse(e.init.body).content), { value: { ok: true, status: 204, text: '' } }) as any)
  return kit
}

test('a task of 10 minutes or more goes to Discord once nothing in the background can wake it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = taskKit(on, clock)
  kit.$ = $

  // Under 10 minutes: nothing.
  await kit.turn()
  await kit.stop(9 * 60_000, 0)
  expect(kit.posted).toEqual([])

  // A background agent holds the task open; its report's turn ends it.
  await kit.turn()
  await kit.stop(8 * 60_000, 1)
  expect(kit.posted).toEqual([])
  await kit.turn() // the agent reports back: same task
  await kit.stop(4 * 60_000, 0)
  expect(kit.posted).toEqual(['✅ Done in ? after 12 min: All done'])

  // A later Stop with no turn between reports nothing again.
  await kit.stop(20 * 60_000, 0)
  expect(kit.posted).toHaveLength(1)

  // A long last reply is cut to one line of 200.
  await kit.turn()
  await kit.stop(11 * 60_000, 0, 'x'.repeat(400))
  expect(kit.posted[1]).toHaveLength(2 + 200)
})

test('the notice names the session: its set title, else the generated one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = taskKit(on, clock)
  kit.$ = $
  on('session.id', () => ({ value: 's' }) as any)
  on('session.root', () => ({ value: '/tmp' }) as any)
  kit.files.add('/home/me/.claude/projects/-tmp/s.jsonl')
  let rows = ['{"type":"ai-title","aiTitle":"Generated"}']
  on('process.run', () => ({ value: { exitCode: 0, stdout: rows.join('\n'), stderr: '' } }) as any)

  await kit.turn()
  await kit.stop(11 * 60_000, 0)
  rows = [...rows, '{"type":"custom-title","customTitle":"Old"}', '{"type":"ai-title","aiTitle":"Later"}', '{"type":"custom-title","customTitle":"Mine"}']
  await kit.turn()
  await kit.stop(11 * 60_000, 0)
  expect(kit.posted).toEqual(['✅ Done in ? [Generated] after 11 min: All done', '✅ Done in ? [Mine] after 11 min: All done'])
})

test('a transcript moved with its session (into a worktree) is found again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = taskKit(on, clock)
  kit.$ = $
  on('session.id', () => ({ value: 's' }) as any)
  let root = '/tmp'
  on('session.root', () => ({ value: root }) as any)
  const before = '/home/me/.claude/projects/-tmp/s.jsonl'
  const after = '/home/me/.claude/projects/-tmp--claude-worktrees-x/s.jsonl'
  kit.files.add(before)
  on('process.run', ($, e: any) =>
    ({
      value: kit.files.has(e.argv.at(-1))
        ? { exitCode: 0, stdout: `{"type":"custom-title","customTitle":"${e.argv.at(-1) === after ? 'Moved' : 'Here'}"}`, stderr: '' }
        : { exitCode: 1, stdout: '', stderr: '' },
    }) as any,
  )

  await kit.turn()
  await kit.stop(11 * 60_000, 0)
  kit.files.delete(before)
  kit.files.add(after)
  root = '/tmp/.claude/worktrees/x'
  await kit.turn()
  await kit.stop(11 * 60_000, 0)
  expect(kit.posted).toEqual(['✅ Done in ? [Here] after 11 min: All done', '✅ Done in ? [Moved] after 11 min: All done'])
})

test('a moved session\'s old transcript left behind is not read again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = taskKit(on, clock)
  kit.$ = $
  on('session.id', () => ({ value: 's' }) as any)
  let root = '/tmp'
  on('session.root', () => ({ value: root }) as any)
  const before = '/home/me/.claude/projects/-tmp/s.jsonl'
  const after = '/home/me/.claude/projects/-tmp--claude-worktrees-x/s.jsonl'
  kit.files.add(before)
  on('process.run', ($, e: any) =>
    ({
      value: kit.files.has(e.argv.at(-1))
        ? { exitCode: 0, stdout: `{"type":"custom-title","customTitle":"${e.argv.at(-1) === after ? 'Moved' : 'Here'}"}`, stderr: '' }
        : { exitCode: 1, stdout: '', stderr: '' },
    }) as any,
  )

  await kit.turn()
  await kit.stop(11 * 60_000, 0)
  // The move copies the transcript and the old file stays, frozen at the move.
  kit.files.add(after)
  root = '/tmp/.claude/worktrees/x'
  await kit.turn()
  await kit.stop(11 * 60_000, 0)
  expect(kit.posted).toEqual(['✅ Done in ? [Here] after 11 min: All done', '✅ Done in ? [Moved] after 11 min: All done'])
})

test('an interrupted task is not reported', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = taskKit(on, clock)
  kit.$ = $
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('session.root', () => ({ value: '/tmp' }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.295' } }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as any)

  await kit.turn()
  await clock.advance(15 * 60_000)
  await $.turn.complete({ answer: '', durationMs: 15 * 60_000, isAborted: true, turnId: 't', reason: 'aborted' } as any)
  await kit.stop(0, 0)
  expect(kit.posted).toEqual([])
})

test('at the Mac, a terminal session gets a desktop notification instead and the app nothing; away, Discord', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = taskKit(on, clock)
  kit.$ = $
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.295' } }) as any)
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('session.root', () => ({ value: '/tmp' }) as any)
  on('session.authorize', () => ({ value: null }) as any)
  let idleMs = 30_000
  on('process.run', ($, e: any) =>
    ({
      value:
        e.argv[0] === 'ioreg'
          ? { exitCode: 0, stdout: `    | |     "HIDIdleTime" = ${idleMs * 1e6}\n`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '' },
    }) as any,
  )
  const notified: string[] = []
  on('ui.notify', ($, e: any) => (notified.push(e.text), { value: { isSent: true, channel: 'ghostty' } }) as any)
  const long = async () => {
    await kit.turn()
    await kit.stop(11 * 60_000, 0)
  }

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  await long()
  expect(notified).toHaveLength(1)
  expect(notified[0]).toMatch(/^✅ Done in .* after 11 min: All done$/)
  expect(kit.posted).toEqual([])

  idleMs = 3 * 60_000 // STATUSBAND_AWAY_MIN's default: away
  await long()
  expect(notified).toHaveLength(1)
  expect(kit.posted).toEqual([notified[0]])

  idleMs = 30_000
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await long()
  expect(notified).toHaveLength(1)
  expect(kit.posted).toHaveLength(1)
})

// Last: it sets the module's threshold to 0.
test('STATUSBAND_LONG_TASK_MIN=0 turns the notice off', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = taskKit(on, clock, { STATUSBAND_LONG_TASK_MIN: '0' })
  kit.$ = $
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.295' } }) as any)
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('session.root', () => ({ value: '/tmp' }) as any)
  on('session.authorize', () => ({ value: null }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as any)

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await kit.turn()
  await kit.stop(30 * 60_000, 0)
  expect(kit.posted).toEqual([])
})

// Beneath the plugin for the cache keep-warm: a session whose transcript ends in
// a reply at NOW that wrote 1h cache (expiring at NOW + 60 min), and the main
// thread's turns, Stops and the prompts the plugin submits.
function keepWarmKit(on: any) {
  mock.env(on, { HOME: '/home/me' })
  const transcript = '/home/me/.claude/projects/-tmp/s.jsonl'
  const reply = (at: number) => ({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { model: 'claude-opus-5-5', usage: { cache_creation: { ephemeral_1h_input_tokens: 100 } } } })
  const kit = { submitted: [] as string[], toasts: [] as string[], replyAt: NOW, drop: false, $: null as any }
  on('ui.toast', ($: any, e: any) => (kit.toasts.push(e.text), { value: undefined }) as any)
  on('ui.log', () => ({ value: undefined }) as any)
  on('prompt.submit', ($: any, e: any) => (kit.submitted.push(e.text), kit.drop ? { drop: 'no' } : { text: e.text }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}) as any)
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.version', () => ({ value: { version: '2.1.299' } }) as any)
  on('session.cwd', () => ({ value: '/tmp' }) as any)
  on('session.id', () => ({ value: 's' }) as any)
  on('session.root', () => ({ value: '/tmp' }) as any)
  on('session.authorize', () => ({ value: null }) as any)
  on('fs.exists', ($: any, e: any) => ({ value: e.path === transcript }) as any)
  on('process.run', ($: any, e: any) =>
    ({ value: e.argv[0] === 'tail' ? { exitCode: 0, stdout: JSON.stringify(reply(kit.replyAt)), stderr: '' } : { exitCode: 1, stdout: '', stderr: '' } }) as any,
  )
  return Object.assign(kit, {
    async start() {
      await kit.$.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
    },
    // The keep-warm turn the submit started: its reply lands in the transcript,
    // and the agents are still out when it stops.
    async keepWarmTurn(now: number) {
      await kit.$.turn.start({ text: '', turnId: 'k' })
      kit.replyAt = now
      await kit.$.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 'k', reason: 'completed' } as any)
      await kit.stop(['subagent'])
    },
    async stop(types: string[]) {
      await kit.$.classic.Stop({ stop_hook_active: false, background_tasks: types.map((type, i) => ({ id: `b${i}`, type, status: 'running', description: 'x' })) } as any)
    },
  })
}

test('an idle main thread waiting on background agents gets one keep-warm turn, in place of the warning', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = keepWarmKit(on)
  kit.$ = $
  await kit.start()
  await kit.stop(['shell', 'subagent'])

  // Over 10 minutes left: nothing yet.
  await clock.advance(49 * 60_000)
  expect(kit.submitted).toEqual([])

  // 10 minutes left: a turn of its own, and no "send a message" warning.
  await clock.advance(60_000 + 1000)
  expect(kit.submitted).toHaveLength(1)
  expect(kit.submitted[0]).toMatch(/^Keep-alive only:/)
  expect(kit.toasts).toEqual(['⏳ Kept the prompt cache for tmp warm while background agents run'])

  // Once per expiry.
  await clock.advance(5 * 60_000)
  expect(kit.submitted).toHaveLength(1)
  expect(kit.toasts).toHaveLength(1)
})

test('an agent out for hours gets a keep-warm turn before each expiry', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = keepWarmKit(on)
  kit.$ = $
  await kit.start()
  await kit.stop(['subagent'])
  // Each keep-warm reply lands a minute past the tick that sent it.
  let now = NOW
  for (let n = 1; n <= 3; n++) {
    await clock.advance(51 * 60_000)
    now += 51 * 60_000
    expect(kit.submitted).toHaveLength(n)
    await kit.keepWarmTurn(now)
  }
})

test('a dropped keep-warm prompt falls back to the warning', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kit = keepWarmKit(on)
  kit.$ = $
  kit.drop = true
  await kit.start()
  await kit.stop(['subagent'])
  await clock.advance(50 * 60_000 + 1000)
  expect(kit.submitted).toHaveLength(1)
  expect(kit.toasts).toEqual(['⏳ Prompt cache for tmp expires at 13:00 (10 min left)'])
})

for (const waitOn of ['a shell and a monitor', 'an agent, with the main thread running again']) {
  test(`no keep-warm turn waiting on ${waitOn}: the warning as before`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const kit = keepWarmKit(on)
    kit.$ = $
    await kit.start()
    if (waitOn.startsWith('a shell')) await kit.stop(['shell', 'monitor'])
    else {
      await kit.stop(['subagent'])
      await $.turn.start({ text: '', turnId: 't' })
    }
    await clock.advance(50 * 60_000 + 1000)
    expect(kit.submitted).toEqual([])
    expect(kit.toasts).toEqual(['⏳ Prompt cache for tmp expires at 13:00 (10 min left)'])
  })
}
