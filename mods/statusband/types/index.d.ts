export type Rate = { kind: string; percentUsed: number; resetsAt?: string }
export type Git = { branch: string; files: number; add: number; del: number }
// today/month: ccusage over every local JSONL, i.e. both accounts on this machine.
export type Cost = { session: number | null; today: number | null; month: number | null }
// The session's own account's Fable weekly bucket, from /api/oauth/usage.
export type Fable = { pct: number | null; fetchedAt: number | null; attemptedAt: number }
// latest: the newest CC on disk, when it is newer than the running one (↑).
export type Version = { current: string; latest: string | null }
export type Context = { tokens: number | null; window: number; percent: number | null }

declare module 'claude-code' {
  interface PluginState {
    statusband: {
      rates: Rate[]
      cacheHit: number | null
      cacheExpiresAt: number | null
      git: Git | null
      cwd: string | null
      tick: number
      cost: Cost
      fable: Fable | null
      model: string | null
      version: Version | null
      context: Context | null
    }
  }
}
