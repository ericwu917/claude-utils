/**
 * One channel session per state dir: <state dir>/channel.lock holds the pid
 * of the server that is connected to Feishu.
 *
 * Feishu hands each event (messages and card clicks alike) to just one of the
 * long connections open for an app, so a second channel session would get a
 * random share of them — and approvals clicked there would miss the pending
 * state held in the first one's memory.
 */

import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'fs'
import { join } from 'path'

export const LOCK_FILE_NAME = 'channel.lock'

export type LockResult =
  | { ok: true; path: string }
  | { ok: false; path: string; holder: number }

export function lockPath(stateDir: string): string {
  return join(stateDir, LOCK_FILE_NAME)
}

// Alive = signal 0 succeeds, or is refused (EPERM: someone else's process).
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function tryCreate(path: string, pid: number): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    writeSync(fd, `${pid}\n`)
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * Take the lock for `pid`. A lock whose holder is gone (killed with -9, so
 * it never released) or whose content isn't a pid is taken over. Throws only
 * on unexpected I/O errors.
 */
export function acquireChannelLock(stateDir: string, pid: number = process.pid): LockResult {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = lockPath(stateDir)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(path, pid)) return { ok: true, path }
    const holder = readHolder(path)
    if (holder !== undefined && holder !== pid && isAlive(holder)) return { ok: false, path, holder }
    try { unlinkSync(path) } catch {}
  }
  const holder = readHolder(path)
  return holder === pid ? { ok: true, path } : { ok: false, path, holder: holder ?? 0 }
}

/** Remove the lock if `pid` still holds it; another session's lock stays. */
export function releaseChannelLock(stateDir: string, pid: number = process.pid): void {
  const path = lockPath(stateDir)
  if (readHolder(path) !== pid) return
  try { unlinkSync(path) } catch {}
}
