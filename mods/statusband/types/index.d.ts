export type Rate = { kind: string; percentUsed: number; resetsAt?: string }
export type Git = { branch: string; files: number; add: number; del: number }
// today/month: ccusage over every local JSONL, i.e. both accounts on this machine.
export type Cost = { session: number | null; today: number | null; month: number | null }
// The session's own account's Fable weekly bucket, from /api/oauth/usage.
// retryAt: the endpoint rate-limited the account (HTTP 429); nobody asks before it.
export type Fable = { pct: number | null; fetchedAt: number | null; attemptedAt: number; retryAt?: number }
// The account's latest 5h/7d reading, shared through $.store by every session of it.
export type SharedRates = { rates: Rate[]; at: number }
// latest: the newest CC on disk, when it is newer than the running one (↑).
export type Version = { current: string; latest: string | null }
export type Context = { tokens: number | null; window: number; percent: number | null }

declare module 'claude-code' {
  interface PluginState {
    statusband: {
      rates: Rate[]
      // When `rates` was read (0: the session's own start-up reading, never shared).
      ratesAt: number
      cacheHit: number | null
      cacheExpiresAt: number | null
      cacheTtlMs: number | null
      // The expiry the 10-minute warning was last raised for (once per expiry).
      cacheWarnedFor: number | null
      git: Git | null
      cwd: string | null
      tick: number
      cost: Cost
      fable: Fable | null
      model: string | null
      version: Version | null
      context: Context | null
      // The auto-compact window (autoCompactWindow, /context's denominator):
      // `context` is measured against it once known.
      compactWindow: number | null
      // The context-fill toast was raised and the fill has not dropped back since.
      ctxWarned: boolean
      // When the running task's first turn started; null between tasks.
      taskStartedAt: number | null
      // The main thread stopped with background agents (or workflows) still to
      // report; false from its next turn's start.
      awaitingAgents: boolean
      // The account's plan tier from /api/oauth/profile (`20x`, `5x`); null otherwise.
      tier: string | null
    }
  }
}
