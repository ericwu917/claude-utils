import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireChannelLock, lockPath, releaseChannelLock } from '../lock.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-lock-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const content = () => readFileSync(lockPath(dir), 'utf8').trim()

// A pid that surely isn't running: a child that has already exited.
function deadPid(): number {
  const p = Bun.spawnSync(['true'])
  return p.pid
}

describe('acquireChannelLock', () => {
  test('no lock: takes it and writes our pid', () => {
    const r = acquireChannelLock(dir, 4242)
    expect(r).toEqual({ ok: true, path: lockPath(dir) })
    expect(content()).toBe('4242')
  })

  test('creates a missing state dir', () => {
    const sub = join(dir, 'a', 'b')
    expect(acquireChannelLock(sub, 4242).ok).toBe(true)
    expect(existsSync(lockPath(sub))).toBe(true)
  })

  test('held by a live process: refused, holder reported, lock untouched', () => {
    writeFileSync(lockPath(dir), `${process.ppid}\n`)
    const r = acquireChannelLock(dir, 4242)
    expect(r).toEqual({ ok: false, path: lockPath(dir), holder: process.ppid })
    expect(content()).toBe(String(process.ppid))
  })

  test('holder is gone: taken over', () => {
    writeFileSync(lockPath(dir), `${deadPid()}\n`)
    expect(acquireChannelLock(dir, 4242).ok).toBe(true)
    expect(content()).toBe('4242')
  })

  test.each(['', 'garbage', '-5', '1.5'])('content %p is not a pid: taken over', s => {
    writeFileSync(lockPath(dir), s)
    expect(acquireChannelLock(dir, 4242).ok).toBe(true)
    expect(content()).toBe('4242')
  })

  test('a second acquire by another live pid is refused', () => {
    expect(acquireChannelLock(dir).ok).toBe(true)
    const r = acquireChannelLock(dir, 4242)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.holder).toBe(process.pid)
  })
})

describe('releaseChannelLock', () => {
  test('removes our own lock', () => {
    acquireChannelLock(dir, 4242)
    releaseChannelLock(dir, 4242)
    expect(existsSync(lockPath(dir))).toBe(false)
  })

  test("leaves another session's lock", () => {
    writeFileSync(lockPath(dir), `${process.ppid}\n`)
    releaseChannelLock(dir, 4242)
    expect(content()).toBe(String(process.ppid))
  })

  test('no lock file: no-op', () => {
    expect(() => releaseChannelLock(dir, 4242)).not.toThrow()
  })
})
