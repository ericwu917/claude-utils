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

  // A ~97-column terminal: line 2 is 99 cells wide in full, so the context
  // token counts go first and every bar still shows (nothing wraps).
  const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 97 } })
  expect(await narrow.findAll({ type: 'Raster' })).toHaveLength(3)
  expect(await narrow.find({ type: 'Text', text: /70k\/200k/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /3d0h/ })).toBeDefined()
  await narrow.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // 5 line icons (folder, branch, cache, warm, cost) + the 5h and 7d bars.
  expect(await desk.findAll({ type: 'Svg' })).toHaveLength(7)
  expect(await desk.find({ type: 'Text', text: /fb 67%/ })).toBeDefined()
  await desk.unmount()
})
