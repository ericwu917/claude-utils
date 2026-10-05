import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Context, Cost, Fable, Git, Rate, Version } from '../types'

// A status band above the prompt, replacing statusline/statusline.sh.
// Terminal: statusline.sh's two lines (bars as Rasters). Desktop: the subset the
// app does not already show, in app style (Svg bars, line icons). Colors,
// thresholds and work-hour pacing mirror statusline.sh. Account-bound data
// (rate limits, Fable) always comes from the session's own account.

const rates = atom({ plugin: 'statusband', key: 'rates' } as const, [] as Rate[])
const cacheHit = atom({ plugin: 'statusband', key: 'cacheHit' } as const, null as number | null)
const cacheExpiresAt = atom({ plugin: 'statusband', key: 'cacheExpiresAt' } as const, null as number | null)
const cacheTtlMs = atom({ plugin: 'statusband', key: 'cacheTtlMs' } as const, null as number | null)
const cacheWarnedFor = atom({ plugin: 'statusband', key: 'cacheWarnedFor' } as const, null as number | null)
const git = atom({ plugin: 'statusband', key: 'git' } as const, null as Git | null)
const cwd = atom({ plugin: 'statusband', key: 'cwd' } as const, null as string | null)
const tick = atom({ plugin: 'statusband', key: 'tick' } as const, 0)
const cost = atom({ plugin: 'statusband', key: 'cost' } as const, { session: null, today: null, month: null } as Cost)
const fable = atom({ plugin: 'statusband', key: 'fable' } as const, null as Fable | null)
const model = atom({ plugin: 'statusband', key: 'model' } as const, null as string | null)
const version = atom({ plugin: 'statusband', key: 'version' } as const, null as Version | null)
const context = atom({ plugin: 'statusband', key: 'context' } as const, null as Context | null)
const ctxWarned = atom({ plugin: 'statusband', key: 'ctxWarned' } as const, false)

// Work hours [start, end), as statusline.sh's STATUSLINE_WORK_START / _END
// (default 9-22): outside them the 5h/7d bars go red, and 7d paces on them
// alone. Read at session start (and again on each reload, which reruns it).
const work = { start: 9, end: 22 }

// Alert thresholds: the context-fill toast (STATUSBAND_CTX_WARN_PCT, default 60)
// and how long before a cache lapses its warning goes out
// (STATUSBAND_CACHE_WARN_MIN, default 10). Read with the work hours.
const alerts = { ctxPct: 60, cacheWarnMs: 10 * 60_000 }

async function readEnvConfig($: EngineInterface) {
  const int = (v: string | undefined) => (v !== undefined && /^\d{1,3}$/.test(v) ? Number(v) : NaN)
  const start = int(await $.env.get('STATUSLINE_WORK_START'))
  const end = int(await $.env.get('STATUSLINE_WORK_END'))
  if (!Number.isNaN(start) && start <= 23) work.start = start
  if (!Number.isNaN(end) && end <= 24) work.end = end
  if (work.start >= work.end) Object.assign(work, { start: 9, end: 22 })
  const ctxPct = int(await $.env.get('STATUSBAND_CTX_WARN_PCT'))
  if (ctxPct >= 1 && ctxPct <= 100) alerts.ctxPct = ctxPct
  const cacheMin = int(await $.env.get('STATUSBAND_CACHE_WARN_MIN'))
  if (cacheMin >= 1 && cacheMin <= 59) alerts.cacheWarnMs = cacheMin * 60_000
}
const CCUSAGE_TTL = 600_000
const USAGE_TTL = 300_000 // between Fable fetch attempts, failures included
const USAGE_STALE = 3600_000 // Fable data older than this draws grey
const FIVE_H_WIDTH = 10
const SEVEN_D_WIDTH = 14
const CTX_WIDTH = 14

const GREEN = '#22c55e'
const YELLOW = '#eab308'
const ORANGE = '#f97316'
const RED = '#ef4444'
const GREY = '#8a8a8a'
const CYAN = '#06b6d4'

// 24x24 stroke icons (lucide shapes) in a mid grey that reads on light and dark.
const strokeIcon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
  `stroke="#8a8a8a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  folder: strokeIcon(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  ),
  branch: strokeIcon(
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  ),
  cache: strokeIcon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>'),
  cost: strokeIcon('<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>'),
  warm: strokeIcon('<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>'),
  cold: strokeIcon(
    '<line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>',
  ),
}

function cacheColor(hit: number) {
  return hit >= 95 ? GREEN : hit >= 80 ? YELLOW : hit >= 50 ? ORANGE : RED
}

async function refreshGit($: EngineInterface) {
  const dir = await $.session.cwd()
  await update($, cwd, () => dir)
  const br = await $.process.run(['git', 'branch', '--show-current'], { cwd: dir, timeoutMs: 5000 })
  if (br.exitCode !== 0) {
    await update($, git, () => null)
    return
  }
  const st = await $.process.run(['git', 'diff', '--shortstat', 'HEAD'], { cwd: dir, timeoutMs: 5000 })
  const num = (re: RegExp) => Number(st.stdout.match(re)?.[1] ?? 0)
  const next: Git = {
    branch: br.stdout.trim(),
    files: num(/(\d+) file/),
    add: num(/(\d+) insertion/),
    del: num(/(\d+) deletion/),
  }
  await update($, git, () => next)
}

let transcriptPath: string | null = null

async function findTranscript($: EngineInterface) {
  if (transcriptPath) return transcriptPath
  const home = await $.env.get('HOME')
  const id = await $.session.id()
  if (!home) return null
  const guess = `${home}/.claude/projects/${(await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(guess)) return (transcriptPath = guess)
  const found = await $.process.run(['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`], { timeoutMs: 5000 })
  return (transcriptPath = found.stdout.split('\n')[0] || null)
}

// Prompt-cache expiry, ported from statusline.sh: anchored on the later of the
// last main-thread assistant entry and the last idle recap (away_summary, a
// model call over the same prefix that renews the TTL); TTL is 5m only when that
// request wrote 5m cache alone, else 1h. Read from the transcript because the
// per-response usage on `turn.step` carries no 5m/1h split and recaps raise no step.
async function refreshCacheExpiry($: EngineInterface) {
  const path = await findTranscript($)
  if (!path) return
  const tail = await $.process.run(['tail', '-n', '300', path], { timeoutMs: 5000 })
  const entries: any[] = []
  for (const line of tail.stdout.split('\n')) {
    try {
      const v = JSON.parse(line)
      if (!v.isSidechain) entries.push(v)
    } catch {}
  }
  const last = entries.findLast(v => v.type === 'assistant' && v.message?.model !== '<synthetic>' && v.message?.usage)
  if (!last) return
  const recap = entries.findLast(v => v.type === 'system' && v.subtype === 'away_summary')
  const at = Math.max(...[last, recap].filter(Boolean).map(v => Date.parse(v.timestamp)).filter(t => !Number.isNaN(t)))
  if (!Number.isFinite(at)) return
  const cc = last.message.usage.cache_creation ?? {}
  const ttl = (cc.ephemeral_5m_input_tokens ?? 0) > 0 && (cc.ephemeral_1h_input_tokens ?? 0) === 0 ? 300_000 : 3600_000
  await update($, cacheExpiresAt, () => at + ttl)
  await update($, cacheTtlMs, () => ttl)
}

// When the main thread's last API response ended: each one renews the cache, but
// the transcript-based expiry above only moves at turn end, so a long turn
// would look like a cache about to lapse.
let lastMainResponseAt = 0

// Ten minutes (alerts.cacheWarnMs) before a warm cache lapses: a toast, and a
// Discord message when a webhook is configured, so a pause can end before the
// next turn pays to rebuild the whole prefix. Once per expiry; a cache whose TTL
// is no longer than the lead time (5m) never qualifies.
async function checkCacheWarning($: EngineInterface) {
  const at = await read($, cacheExpiresAt)
  const ttl = await read($, cacheTtlMs)
  if (at === null || ttl === null || ttl <= alerts.cacheWarnMs) return
  const expires = Math.max(at, lastMainResponseAt + ttl)
  const now = await $.clock.now()
  const left = expires - now
  if (left <= 0 || left > alerts.cacheWarnMs || (await read($, cacheWarnedFor)) === expires) return
  await update($, cacheWarnedFor, () => expires)
  const dir = (await read($, cwd))?.split('/').pop() ?? '?'
  const text = `Prompt cache for ${dir} expires at ${hhmm(expires)} (${Math.ceil(left / 60_000)} min left)`
  $.ui.toast(`⏳ ${text}`, { timeoutMs: 15_000 })
  await notifyDiscord($, `⏳ ${text}. Send a message to keep it warm.`)
}

// Posts to the Discord webhook whose URL is in ~/.config/discord-webhook, as
// ~/bin/discord-notify does; nothing when that file is absent. The URL is
// never logged.
async function notifyDiscord($: EngineInterface, content: string) {
  const home = await $.env.get('HOME')
  if (!home) return
  const file = `${home}/.config/discord-webhook`
  if (!(await $.fs.exists(file))) return
  const url = String(await $.fs.read(file)).trim()
  if (!url.startsWith('https://')) return
  try {
    const res = await $.http.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    })
    if (!res.ok) $.ui.log(`statusband: Discord webhook got HTTP ${res.status}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`statusband: Discord webhook failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// Today's and month-to-date cost: the CLI statusline's ccusage cache, refreshed
// through the shared statusline-refresh-caches.sh (same file, TTL and lock).
// ccusage scans every local JSONL, so this is the machine's total across accounts.
async function refreshCcusage($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) return
  const cache = `${home}/.claude/ccusage-cache.json`
  const script = `${home}/.claude/statusline-refresh-caches.sh`
  const isFresh = (await $.fs.exists(cache)) && (await $.clock.now()) - (await $.fs.stat(cache)).mtimeMs <= CCUSAGE_TTL
  if (!isFresh && (await $.fs.exists(script))) {
    await $.process.run(['bash', script, 'ccusage'], { timeoutMs: 120_000 })
  }
  if (!(await $.fs.exists(cache))) return
  try {
    const c = JSON.parse(String(await $.fs.read(cache)))
    await update($, cost, v => ({ ...v!, today: c.today ?? null, month: c.month ?? null }))
  } catch {}
}

// The session's own account's Fable weekly bucket. Not the shared script: that
// one reads the CLI account's keychain token, and the app may sign in as another
// account. The session's credential rides as an opaque handle the host fills in.
// Matching rule kept in step with FABLE_DEF in statusline-refresh-caches.sh.
//
// Sessions of one account share the reading through $.store (it outlives a
// session), so N open sessions make one request per TTL, not N.
async function refreshFable($: EngineInterface) {
  const now = await $.clock.now()
  const prev = await read($, fable)
  if (prev && now - prev.attemptedAt <= USAGE_TTL) return
  const key = await fableStoreKey($)
  const shared = key ? ((await $.store.get(key)) as Fable | undefined) : undefined
  if (shared && now - shared.attemptedAt <= USAGE_TTL) {
    await update($, fable, () => shared)
    return
  }
  let next: Fable = { pct: prev?.pct ?? null, fetchedAt: prev?.fetchedAt ?? null, attemptedAt: now }
  // Claim the slot before the request, so a session ticking meanwhile reuses it.
  if (key) await $.store.set(key, next)
  try {
    const auth = await $.session.authorize()
    if (auth) {
      const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-utils-statusband' },
        auth: auth.handle,
      })
      const body = res.ok ? JSON.parse(res.text) : null
      if (body && Array.isArray(body.limits)) {
        const b = body.limits.find(
          (l: any) => l.kind === 'weekly_scoped' && String(l.scope?.model?.display_name ?? '').toLowerCase().startsWith('fable'),
        )
        next = { pct: typeof b?.percent === 'number' ? b.percent : null, fetchedAt: now, attemptedAt: now }
      } else {
        $.ui.log(`statusband: usage fetch got HTTP ${res.status}`, { to: 'debug' })
      }
    } else {
      $.ui.log('statusband: no first-party credential for the usage fetch', { to: 'debug' })
    }
  } catch (err) {
    $.ui.log(`statusband: usage fetch failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
  if (key) await $.store.set(key, next)
  await update($, fable, () => next)
}

// The account this session runs as, for keying shared per-account data. A CLI
// (terminal) session runs as the account ~/.claude.json holds, which its
// credential belongs to; it never trusts CLAUDE_CODE_ACCOUNT_UUID, since a CLI
// started from the app's terminal may inherit the app's. Other sessions (the
// desktop host) are named there. Neither → null, and each session fetches alone.
let isTerminalSession = false
let accountKey: string | null | undefined

async function fableStoreKey($: EngineInterface) {
  if (accountKey === undefined) {
    accountKey = null
    if (isTerminalSession) {
      const home = await $.env.get('HOME')
      if (home && (await $.fs.exists(`${home}/.claude.json`))) {
        try {
          accountKey = JSON.parse(String(await $.fs.read(`${home}/.claude.json`))).oauthAccount?.accountUuid ?? null
        } catch {}
      }
    } else {
      accountKey = (await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')) ?? null
    }
  }
  return accountKey ? `fable:${accountKey}` : null
}

// `claude-opus-5-5[1m]` → `Opus 5.5 (1M context)`, the status line's display name;
// anything not spelled as a model id (an alias, a 3P name) passes through.
function displayModel(id: string) {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i)
  if (!m) return id
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M context)' : ''}`
}

function cmpSemver(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

// The newest CC installed on disk (a session keeps running the version it
// started with); same layouts as statusline.sh's cc_latest_installed.
async function latestInstalled($: EngineInterface, home: string) {
  const native = `${home}/.local/share/claude/versions`
  if (await $.fs.exists(native)) {
    const names = (await $.fs.list(native)).map(e => e.name).filter(n => /^\d+\.\d+\.\d+$/.test(n))
    return names.sort(cmpSemver).at(-1) ?? null
  }
  for (const p of [
    `${home}/.claude/local/node_modules/@anthropic-ai/claude-code/package.json`,
    `${home}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json`,
    `${home}/.bun/install/global/node_modules/@anthropic-ai/claude-code/package.json`,
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/package.json',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json',
  ]) {
    if (await $.fs.exists(p)) {
      try {
        return JSON.parse(String(await $.fs.read(p))).version ?? null
      } catch {
        return null
      }
    }
  }
  return null
}

async function refreshModelAndVersion($: EngineInterface) {
  const id = await $.session.model()
  await update($, model, () => displayModel(id))
  const current = (await $.session.version()).base ?? (await $.session.version()).version
  const home = await $.env.get('HOME')
  const disk = home ? await latestInstalled($, home) : null
  const latest = disk && /^\d+\.\d+\.\d+$/.test(current) && cmpSemver(disk, current) > 0 ? disk : null
  await update($, version, () => ({ current, latest }))
}

const toContext = (c: { tokens?: number; window: number; percent?: number }): Context => ({
  tokens: c.tokens ?? null,
  window: c.window,
  percent: c.percent ?? null,
})

// A toast each time the context fill crosses alerts.ctxPct (60%) upward;
// dropping back under (a /compact, a /clear) re-arms it.
async function setContext($: EngineInterface, next: Context) {
  await update($, context, () => next)
  const pct = next.percent
  if (pct === null) return
  if (pct < alerts.ctxPct) {
    await update($, ctxWarned, () => false)
  } else if (!(await read($, ctxWarned))) {
    await update($, ctxWarned, () => true)
    const used = next.tokens === null ? '' : ` (${fmtTokens(next.tokens)}/${fmtTokens(next.window)})`
    $.ui.toast(`Context window at ${pct}%${used}`, { timeoutMs: 10_000 })
  }
}

function fmtCost(c: number | null) {
  if (c === null) return '--'
  if (c < 10) return `$${c.toFixed(2)}`
  if (c < 100) return `$${c.toFixed(1)}`
  if (c < 1000) return `$${c.toFixed(0)}`
  if (c < 10000) return `$${(c / 1000).toFixed(1)}K`
  return `$${(c / 1000).toFixed(0)}K`
}

function rateColor(usage: number, time: number) {
  if (usage >= 90) return RED
  if (time <= 0 || usage <= time) return GREEN
  if (usage < 50 || usage <= Math.floor((time * 3) / 2)) return YELLOW
  return ORANGE
}

// Share of the window's work hours [work.start, work.end) already elapsed.
function activePct(ws: number, we: number, now: number) {
  let elapsed = 0
  let total = 0
  const day = new Date(ws)
  day.setHours(0, 0, 0, 0)
  for (; day.getTime() <= we; day.setDate(day.getDate() + 1)) {
    const a = new Date(day).setHours(work.start)
    const b = new Date(day).setHours(work.end)
    elapsed += Math.max(0, Math.min(b, now) - Math.max(a, ws))
    total += Math.max(0, Math.min(b, we) - Math.max(a, ws))
  }
  return total > 0 ? Math.floor((elapsed * 100) / total) : 0
}

function hhmm(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtRemaining(ms: number) {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(sec / 86400)
  if (days >= 1) return `${days}d${Math.floor((sec % 86400) / 3600)}h`
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`
}

type Pace = { label: string; usage: number; time: number; color: string; remaining?: string }

function pace(label: string, r: Rate | undefined, now: number): Pace | null {
  if (!r) return null
  const usage = Math.round(r.percentUsed)
  const reset = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  const hour = new Date(now).getHours()
  const offHours = hour < work.start || hour >= work.end
  let time = 0
  if (!Number.isNaN(reset)) {
    time =
      label === '5h'
        ? Math.floor(((5 * 3600_000 - (reset - now)) * 100) / (5 * 3600_000))
        : activePct(reset - 7 * 86400_000, reset, now)
    time = Math.min(100, Math.max(0, time))
  }
  const color = offHours ? RED : rateColor(usage, time)
  if (Number.isNaN(reset)) return { label, usage, time, color }
  return { label, usage, time, color, remaining: fmtRemaining(reset - now) }
}

// Terminal bars as one Raster row: the track and the elapsed-time band are cell
// backgrounds (no ░ texture, no │ cell), and the fill ends in a 1/8-width block,
// so a 10-cell bar resolves 80 steps. The app's Svg bar, in terminal cells.
// Track grey follows CC's theme (a Raster takes raw colors, no theme keys):
// light themes get a light track; dark and `auto` (the terminal's own, which a
// mod can't see) keep the dark one. Re-read when /config changes the theme.
const TRACK_DARK = 0x3a3a3a
const TRACK_LIGHT = 0xd4d4d4
let track = TRACK_DARK

async function readTheme($: EngineInterface) {
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  track = String(theme ?? '').startsWith('light') ? TRACK_LIGHT : TRACK_DARK
}
const EIGHTHS = [0x20, 0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589, 0x2588] // ' ' ▏▎▍▌▋▊▉█

const hexInt = (hex: string) => parseInt(hex.slice(1), 16)

function mixInt(a: number, b: number, t: number) {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s
  return ch(16) | ch(8) | ch(0)
}

function barCells(width: number, usage: number, color: string, time?: number, mark?: { pct: number; color: string }) {
  const fg = hexInt(color)
  const band = mixInt(track, fg, 0.35)
  const u = (Math.min(100, Math.max(0, usage)) * width) / 100
  const t = ((time === undefined ? 0 : Math.min(100, Math.max(0, time))) * width) / 100
  const m = mark ? Math.min(width - 1, Math.floor((mark.pct * width) / 100)) : -1
  // Past the pace, the fill takes the darker shade (whole cells: a cell has one fg).
  const overrunFrom = isOverrun(usage, time) ? Math.round(t) : width
  const words = new Uint32Array(width * 3)
  for (let i = 0; i < width; i++) {
    const bg = t - i >= 0.5 ? band : track
    const eighth = Math.max(0, Math.min(8, Math.round((u - i) * 8)))
    const ink = i >= overrunFrom ? mixInt(fg, 0x000000, OVERRUN_SHADE) : fg
    // A second meter sharing the window (Fable on 7d) as a ┃ (the CLI's overlay):
    // on the track in its own pace color; inside the fill, a dark rule on the
    // fill so the bar stays whole instead of showing a notch.
    const isInFill = eighth >= 4
    const cell =
      i === m
        ? [0x2503, isInFill ? mixInt(ink, 0x000000, 0.6) : hexInt(mark!.color), isInFill ? ink : bg]
        : [EIGHTHS[eighth]!, ink, eighth === 8 ? ink : bg]
    words.set(cell, i * 3)
  }
  let s = ''
  for (const byte of new Uint8Array(words.buffer)) s += String.fromCharCode(byte)
  return btoa(s)
}

function ctxColor(pct: number) {
  return pct >= 90 ? RED : pct >= 75 ? ORANGE : pct >= 50 ? YELLOW : GREEN
}

const fmtTokens = (n: number) => (n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`)

// Terminal lines are laid out to the band's width by hand rather than wrapped,
// so the band stays two rows and a narrow terminal loses detail, not bars. Each
// line is runs of pieces; the run with the highest `drop` goes first until the
// line fits, and `drop: 0` runs always stay.
type Piece =
  | { text: string; color?: string; dim?: boolean }
  | { raster: string; columns: number; cells: string }
  | { link: string; href: string; onPress: () => void }
type Run = { drop: number; pieces: Piece[] }

// Cells a string takes: emoji (U+1F000 up, and ⏳) are two wide.
function cellWidth(s: string) {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    w += cp >= 0x1f000 || cp === 0x23f3 ? 2 : 1
  }
  return w
}

const runWidth = (r: Run) =>
  r.pieces.reduce((w, p) => w + ('raster' in p ? p.columns : cellWidth('link' in p ? p.link : p.text)), 0)

function fitLine(runs: Run[], columns: number) {
  const kept = [...runs]
  let width = kept.reduce((w, r) => w + runWidth(r), 0)
  while (width > columns) {
    let worst = -1
    kept.forEach((r, i) => {
      if (r.drop > 0 && (worst < 0 || r.drop > kept[worst]!.drop)) worst = i
    })
    if (worst < 0) break
    width -= runWidth(kept[worst]!)
    kept.splice(worst, 1)
  }
  return kept.flatMap(r => r.pieces)
}

// `#rrggbb` mixed toward white by `t` (0..1).
function tint(hex: string, t: number) {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16)
    return Math.round(v + (255 - v) * t)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${ch(1)}${ch(3)}${ch(5)}`
}

// Usage past the pace (ahead of elapsed time) is drawn a shade darker, so how
// far a bar overran its time shows even though the fill covers the elapsed band.
const OVERRUN_SHADE = 0.35
const shade = (hex: string) => `#${mixInt(hexInt(hex), 0x000000, OVERRUN_SHADE).toString(16).padStart(6, '0')}`

// Only a paced bar (time > 0) can overrun: the context bar has no pace, and at
// a window's very start there is nothing elapsed to compare against.
const isOverrun = (usage: number, time: number | undefined) => time !== undefined && time > 0 && usage > time

// A square track + fill, pace shown as a lighter elapsed band. Neutral greys
// at partial opacity read on both light and dark themes (the SVG is an image,
// so it cannot follow the page's theme variables).
function rateSvg(p: Pace, w: number, mark?: { pct: number; color: string }) {
  const h = 16
  const ty = 2
  const th = 12
  const fill = Math.max(0, Math.min(w, (p.usage * w) / 100))
  const elapsed = Math.max(0, Math.min(w, (p.time * w) / 100))
  // Pace as a "buffered" band: elapsed time is a faint tint of the fill's color,
  // usage fills over it — ahead of the band means burning faster than time.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect x="0" y="${ty}" width="${w}" height="${th}" fill="rgba(128,128,128,0.30)"/>` +
    `<rect x="0" y="${ty}" width="${elapsed}" height="${th}" fill="${p.color}" fill-opacity="0.35"/>` +
    (fill > 0 ? `<rect x="0" y="${ty}" width="${fill}" height="${th}" fill="${p.color}"/>` : '') +
    (isOverrun(p.usage, p.time)
      ? `<rect x="${elapsed}" y="${ty}" width="${fill - elapsed}" height="${th}" fill="${shade(p.color)}"/>`
      : '') +
    // A second meter sharing this window (Fable on 7d) as a thin lane along the
    // bottom, in a lighter tint of its own pace color so it stays legible even
    // over a fill of the same hue.
    (mark && mark.pct > 0
      ? `<rect x="0" y="${ty + th - 3}" width="${(Math.min(100, mark.pct) * w) / 100}" height="3" fill="${tint(mark.color, 0.5)}"/>`
      : '') +
    `</svg>`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    isTerminalSession = e.surface === 'terminal'
    await readEnvConfig($)
    await readTheme($).catch(() => {})
    const usage = await $.session.usage()
    await update($, rates, () => usage.rateLimits.map(x => ({ ...x })))
    await update($, cost, v => ({ ...v!, session: usage.cost?.usd ?? null }))
    await setContext($, toContext(usage.context))
    await refreshModelAndVersion($)
    await refreshGit($)
    await refreshCacheExpiry($)
    // ccusage and the usage endpoint can take seconds: never hold up the session.
    void refreshCcusage($)
    void refreshFable($)
    // Pace band, countdowns and warm→cold move with the clock; git and idle
    // recaps change outside turns; the cost and Fable caches age out (each
    // refresh is TTL-gated, so most ticks do nothing there).
    $.clock.every(60_000, () => {
      void update($, tick, n => (n ?? 0) + 1)
      void refreshGit($)
      void refreshCacheExpiry($)
      void refreshCcusage($)
      void refreshFable($)
      void refreshModelAndVersion($)
      void checkCacheWarning($)
    })
    return r
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const r = await next(e)
    await readTheme($).catch(() => {})
    void update($, tick, n => (n ?? 0) + 1) // redraw the bars in the new track grey
    return r
  })

  // /clear starts a new conversation (and transcript) in the same process, and
  // raises session.end, never session.start: drop what belonged to the old one,
  // or ⏳ and the expiry warning keep reading the old transcript's cache.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      transcriptPath = null
      lastMainResponseAt = 0
      await update($, cacheHit, () => null)
      await update($, cacheExpiresAt, () => null)
      await update($, cacheTtlMs, () => null)
      await update($, cacheWarnedFor, () => null)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, rates, () => e.rateLimits.map(x => ({ ...x })))
    }
    if (e.changed.includes('cost')) {
      await update($, cost, v => ({ ...v!, session: e.cost?.usd ?? null }))
    }
    if (e.changed.includes('context')) {
      await setContext($, toContext(e.context))
    }
    return next(e)
  })

  // Hit rate of the main thread's latest API response (statusline's current_usage).
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (!e.agentId && u) {
      lastMainResponseAt = await $.clock.now()
      const denom = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
      if (denom > 0) {
        await update($, cacheHit, () => Math.floor((u.cache_read_input_tokens * 100) / denom))
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await refreshGit($)
    if (e.agentId === undefined) {
      await refreshCacheExpiry($)
      await refreshModelAndVersion($) // /model can switch it between turns
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    await read($, tick)
    const now = await $.clock.now()
    const dir = await read($, cwd)
    const g = await read($, git)
    const hit = await read($, cacheHit)
    const expiresAt = await read($, cacheExpiresAt)
    const rl = await read($, rates)
    const c = await read($, cost)
    const f = await read($, fable)
    const ctx = await read($, context)

    const dirName = dir ? dir.split('/').pop() : '?'
    const pct = ctx?.percent ?? 0
    const used = ctx?.tokens ?? Math.round((pct * (ctx?.window ?? 0)) / 100)
    const p7 = pace('7d', rl.find(x => x.kind === 'seven_day'), now)
    // Fable's weekly window shares 7d's reset, so it is paced against 7d's time;
    // stale data goes grey, which beats the off-hours red (as in statusline.sh).
    let fb: { pct: number; color: string } | undefined
    if (f?.pct != null) {
      const pct = Math.round(f.pct)
      const hour = new Date(now).getHours()
      const isStale = f.fetchedAt === null || now - f.fetchedAt > USAGE_STALE
      const color = isStale ? GREY : hour < work.start || hour >= work.end ? RED : rateColor(pct, p7?.time ?? 0)
      fb = { pct, color }
    }
    const limits = [
      { label: '5h', p: pace('5h', rl.find(x => x.kind === 'five_hour'), now), cells: FIVE_H_WIDTH, mark: undefined },
      { label: '7d', p: p7, cells: SEVEN_D_WIDTH, mark: fb },
    ]

    // Desktop: muted line icons instead of emoji, spacing instead of pipes, and
    // color only where it signals something (a healthy value stays in the text color).
    if (e.surface === 'desktop') {
      const { Box, Text, Svg, Button } = $.ui.resolve(e)
      const icon = (name: keyof typeof ICONS) => <Svg source={ICONS[name]} alt={name} width={14} height={14} />
      const warn = (c: string) => (c === GREEN ? undefined : c)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3}>
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              {icon('folder')}
              <Box flexDirection="row" alignItems="center">
                <Text>{dirName}</Text>
                {dir ? (
                  <Button key="open-dir" plain dimColor label="↗" onPress={() => void $.process.run(['open', dir])} />
                ) : null}
              </Box>
            </Box>
            {g ? (
              <Box flexDirection="row" alignItems="center" columnGap={1}>
                {icon('branch')}
                <Text>{g.branch || '(detached)'}</Text>
                {g.files > 0 ? <Text dimColor>{`${g.files} files`}</Text> : null}
                {g.files > 0 ? <Text color={GREEN}>{`+${g.add}`}</Text> : null}
                {g.files > 0 ? <Text color={RED}>{`−${g.del}`}</Text> : null}
              </Box>
            ) : null}
            {/* Hit rate and expiry read as one prompt-cache group. */}
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              {icon('cache')}
              {hit === null ? <Text dimColor>--</Text> : <Text color={warn(cacheColor(hit))}>{`${hit}%`}</Text>}
              {expiresAt === null ? null : now < expiresAt ? icon('warm') : icon('cold')}
              {expiresAt === null ? null : now < expiresAt ? <Text>{hhmm(expiresAt)}</Text> : <Text dimColor>cold</Text>}
            </Box>
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              {icon('cost')}
              <Text>{fmtCost(c.session)}</Text>
              <Text dimColor>{`/ ${fmtCost(c.today)} / ${fmtCost(c.month)}`}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3}>
            {/* Context fill, as the CLI's first bar: no elapsed band (time 0). */}
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              <Text dimColor>ctx</Text>
              <Svg
                source={rateSvg({ label: 'ctx', usage: pct, time: 0, color: ctxColor(pct) }, CTX_WIDTH * 8)}
                alt={`context ${pct}%`}
                width={CTX_WIDTH * 8}
                height={16}
              />
              <Text color={warn(ctxColor(pct))}>{`${pct}%`}</Text>
              <Text dimColor>{`${fmtTokens(used)}/${fmtTokens(ctx?.window ?? 0)}`}</Text>
            </Box>
            {limits.map(({ label, p, cells, mark }) => (
              <Box flexDirection="row" alignItems="center" columnGap={1}>
                <Text dimColor>{label}</Text>
                {p ? <Svg source={rateSvg(p, cells * 8, mark)} alt={`${label} ${p.usage}%`} width={cells * 8} height={16} /> : null}
                {p ? <Text color={warn(p.color)}>{`${p.usage}%`}</Text> : <Text dimColor>--</Text>}
                {mark ? <Text color={warn(mark.color)}>{`fb ${mark.pct}%`}</Text> : null}
                {p?.remaining ? <Text dimColor>{p.remaining}</Text> : null}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    // Terminal: statusline.sh's two lines (less its trailing durations and ⏱),
    // in its emoji / pipe style, with the bars drawn as Rasters. Each line is
    // fitted to the band's width; what goes first when it is narrow is the
    // detail (today/month cost, diff, expiry, branch; token counts, countdowns),
    // never the bars, the model or the hit rate.
    if (e.surface === 'terminal') {
      const { Box, Text, Raster, Markdown } = $.ui.resolve(e)
      const mdl = await read($, model)
      const ver = await read($, version)
      const sep: Piece = { text: ' | ', dim: true }

      const line1: Run[] = [
        {
          drop: 0,
          pieces: [
            { text: `[${mdl ?? '?'}${ver ? ` v${ver.current}` : ''}`, color: CYAN },
            ...(ver?.latest ? [{ text: '↑', color: YELLOW }] : []),
            { text: ']', color: CYAN },
            { text: ' 📁 ' },
            // A file: link, as statusline.sh's OSC 8 one: cmd+click opens it in
            // Finder through the terminal; a plain click (fullscreen) runs open.
            dir
              ? { link: dirName ?? dir, href: `file://${encodeURI(dir)}`, onPress: () => void $.process.run(['open', dir]) }
              : { text: '?' },
          ],
        },
        ...(g
          ? [
              { drop: 2, pieces: [sep, { text: '🔀 ' }, { text: g.branch || '(detached)', color: GREEN }] },
              {
                drop: 4,
                pieces: [sep, { text: `${g.files} files ` }, { text: `+${g.add}`, color: GREEN }, { text: ` -${g.del}`, color: RED }],
              },
            ]
          : []),
        {
          drop: 0,
          pieces: [sep, ...(hit === null ? [{ text: '💾 --', dim: true }] : [{ text: '💾 ' }, { text: `${hit}%`, color: cacheColor(hit) }])],
        },
        ...(expiresAt === null
          ? []
          : [{ drop: 3, pieces: [now < expiresAt ? { text: ` ⏳${hhmm(expiresAt)}`, color: GREEN } : { text: ' ❄cold', dim: true }] }]),
        { drop: 1, pieces: [sep, { text: fmtCost(c.session), color: YELLOW }] },
        { drop: 5, pieces: [{ text: `/${fmtCost(c.today)}/${fmtCost(c.month)}`, dim: true }] },
      ]

      const line2: Run[] = [
        {
          drop: 0,
          pieces: [
            { raster: 'ctx', columns: CTX_WIDTH, cells: barCells(CTX_WIDTH, pct, ctxColor(pct)) },
            { text: ` ${pct}%`, color: ctxColor(pct) },
          ],
        },
        { drop: 5, pieces: [{ text: ` (${fmtTokens(used)}/${fmtTokens(ctx?.window ?? 0)})`, dim: true }] },
        ...limits.flatMap(({ label, p, cells, mark }): Run[] => [
          {
            drop: 0,
            pieces: [
              sep,
              { text: `${label} ` },
              ...(p
                ? [
                    { raster: label, columns: cells, cells: barCells(cells, p.usage, p.color, p.time, mark) },
                    { text: ` ${p.usage}%`, color: p.color },
                  ]
                : [{ text: '--', dim: true }]),
              ...(label === '7d' ? [mark ? { text: ` fb${mark.pct}%`, color: mark.color } : { text: ' fb--', dim: true }] : []),
            ],
          },
          ...(p?.remaining ? [{ drop: label === '5h' ? 4 : 3, pieces: [{ text: ` (${p.remaining})`, dim: true }] }] : []),
        ]),
      ]

      const draw = (pieces: Piece[]) =>
        pieces.map(p =>
          'raster' in p ? (
            <Raster key={p.raster} columns={p.columns} rows={1} cells={p.cells} />
          ) : 'link' in p ? (
            <Markdown key="dir" text={`[${p.link.replace(/[[\]\\]/g, '\\$&')}](${p.href})`} onLinkPress={p.onPress} />
          ) : (
            <Text color={p.color} dimColor={p.dim}>
              {p.text}
            </Text>
          ),
        )
      const columns = e.props.bodyColumns
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">{draw(fitLine(line1, columns))}</Box>
          <Box flexDirection="row">{draw(fitLine(line2, columns))}</Box>
        </Box>
      )
    }

    return next(e)
  })
}
