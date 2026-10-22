/**
 * Inbound images / files → <realpath(state dir)>/inbox, for Claude to Read.
 *
 * Each resource is streamed to disk with a size cap and a timeout; anything
 * that fails leaves no file behind. The Feishu request itself is injected
 * (server.ts passes the SDK call), so tests drive this with fake streams.
 */

import { lstatSync, mkdirSync, readdirSync, realpathSync, chmodSync, unlinkSync } from 'fs'
import { open, unlink, type FileHandle } from 'fs/promises'
import { join } from 'path'
import {
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  INBOX_TTL_MS,
  MAX_RESOURCES_PER_MESSAGE,
  RESOURCE_TIMEOUT_MS,
  imageExt,
  inboxFileName,
  isInboxChild,
  resourceMetaKey,
  resourceNote,
  type InboundResource,
  type ResourceFailure,
} from './lib.ts'

/**
 * Create <realpath(stateDir)>/inbox (0700) and return its path. The state
 * dir is resolved first — it may sit behind a symlink, and the path Claude
 * gets must match the real one granted with --add-dir. Throws when the inbox
 * can't be made or is not a plain directory (a symlink is refused).
 */
export function prepareInbox(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const inbox = join(realpathSync(stateDir), 'inbox')
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  const st = lstatSync(inbox)
  if (!st.isDirectory()) throw new Error(`${inbox} is not a directory`)
  chmodSync(inbox, 0o700) // mkdir's mode is cut by umask, and an existing dir keeps its own
  return inbox
}

/**
 * Delete regular files directly in `dir` last modified more than 7 days
 * before `now`. Not recursive; symlinks and directories are left alone
 * (lstat, never followed). Returns how many were deleted.
 */
export function cleanInbox(dir: string, now: number, log: (msg: string) => void): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    log(`inbox cleanup: cannot list ${dir}: ${err instanceof Error ? err.message : err}`)
    return 0
  }
  let removed = 0
  for (const name of names) {
    const p = join(dir, name)
    try {
      const st = lstatSync(p)
      if (st.isFile() && st.mtimeMs + INBOX_TTL_MS < now) {
        unlinkSync(p)
        removed++
      }
    } catch (err) {
      log(`inbox cleanup: ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return removed
}

/** The body of a resource request, as the injected fetcher returns it. */
export type FetchedResource = {
  stream: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void }
  contentType?: string
  contentLength?: number
}

/**
 * Starts the request for one resource. Throws on failure, with a message
 * that is safe to log (no tokens). `signal` fires on timeout.
 */
export type ResourceFetcher = (r: InboundResource, signal: AbortSignal) => Promise<FetchedResource>

export type DownloadOptions = {
  /** From prepareInbox; undefined = the inbox couldn't be made, every resource fails. */
  inbox: string | undefined
  messageId: string
  at: Date
  fetch: ResourceFetcher
  /** Diagnostics (stderr in server.ts). */
  log: (msg: string) => void
  maxImageBytes?: number
  maxFileBytes?: number
  maxCount?: number
  timeoutMs?: number
}

export type DownloadResult = {
  /** image_N / file_N → absolute path, for each resource that was saved. */
  meta: Record<string, string>
  /** image_N / file_N → why it wasn't saved, for parseContent's placeholders. */
  notes: Record<string, string>
}

type Outcome = { ok: true; path: string } | { ok: false; why: Exclude<ResourceFailure, 'over-count'>; detail: string }

/**
 * Download a message's resources in parallel. Only the first `maxCount` (9)
 * are fetched; each has its own timeout (30s). Never throws: a resource that
 * fails, is too large, times out or is over the count gets a note instead of
 * a meta key — the others are unaffected.
 */
export async function downloadResources(resources: InboundResource[], o: DownloadOptions): Promise<DownloadResult> {
  const maxCount = o.maxCount ?? MAX_RESOURCES_PER_MESSAGE
  const meta: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const picked = resources.slice(0, maxCount)
  for (const r of resources.slice(maxCount)) notes[resourceMetaKey(r)] = resourceNote(r.kind, 'over-count', { maxCount })

  const results = await Promise.allSettled(picked.map(r => downloadOne(r, o)))
  results.forEach((res, i) => {
    const r = picked[i]!
    const key = resourceMetaKey(r)
    const out: Outcome =
      res.status === 'fulfilled' ? res.value : { ok: false, why: 'failed', detail: String(res.reason) }
    if (out.ok) {
      meta[key] = out.path
    } else {
      notes[key] = resourceNote(r.kind, out.why, { maxBytes: maxBytes(r, o) })
      o.log(`${key} of ${o.messageId} not downloaded: ${out.detail}`)
    }
  })
  return { meta, notes }
}

function maxBytes(r: InboundResource, o: DownloadOptions): number {
  return r.kind === 'image' ? (o.maxImageBytes ?? IMAGE_MAX_BYTES) : (o.maxFileBytes ?? FILE_MAX_BYTES)
}

async function downloadOne(r: InboundResource, o: DownloadOptions): Promise<Outcome> {
  const timeoutMs = o.timeoutMs ?? RESOURCE_TIMEOUT_MS
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // The SDK call takes no abort signal, so a request stuck before its
  // response can't be cancelled — the race just stops waiting for it, and
  // saveOne drops (and deletes) whatever arrives later.
  const timedOut = new Promise<Outcome>(res => {
    timer = setTimeout(() => {
      ac.abort()
      res({ ok: false, why: 'failed', detail: `timed out after ${timeoutMs / 1000}s` })
    }, timeoutMs)
  })
  try {
    return await Promise.race([saveOne(r, o, ac.signal), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

async function saveOne(r: InboundResource, o: DownloadOptions, signal: AbortSignal): Promise<Outcome> {
  if (!o.inbox) return { ok: false, why: 'failed', detail: 'inbox unavailable' }
  const inbox = o.inbox
  const max = maxBytes(r, o)
  const tooLarge: Outcome = { ok: false, why: 'too-large', detail: `over ${max} bytes` }

  let fetched: FetchedResource
  try {
    fetched = await o.fetch(r, signal)
  } catch (err) {
    return { ok: false, why: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
  const { stream } = fetched
  const stop = () => stream.destroy?.(new Error('download stopped'))
  if (signal.aborted) {
    stop()
    return { ok: false, why: 'failed', detail: 'timed out' }
  }
  if (fetched.contentLength !== undefined && fetched.contentLength > max) {
    stop()
    return tooLarge
  }
  signal.addEventListener('abort', stop, { once: true })

  let fh: FileHandle | undefined
  let path: string | undefined
  let saved = false
  // Open the file once the extension is known: for an image that needs the
  // first bytes (magic number) when the Content-Type doesn't say.
  const openTarget = async (head: Uint8Array): Promise<FileHandle> => {
    const ext = r.kind === 'image' ? imageExt(fetched.contentType, head) : undefined
    const name = inboxFileName({ at: o.at, messageId: o.messageId, kind: r.kind, n: r.n, ext, name: r.name })
    const p = join(inbox, name)
    if (!isInboxChild(inbox, p)) throw new Error(`refusing path outside the inbox: ${name}`)
    // wx: never overwrite, never follow an existing symlink.
    const h = await open(p, 'wx', 0o600)
    path = p
    return h
  }
  try {
    let bytes = 0
    let head: Uint8Array[] = []
    let headBytes = 0
    for await (const chunk of stream) {
      if (signal.aborted) return { ok: false, why: 'failed', detail: 'timed out' }
      bytes += chunk.length
      if (bytes > max) {
        stop()
        return tooLarge
      }
      if (fh) {
        await writeAll(fh, chunk)
        continue
      }
      head.push(chunk)
      headBytes += chunk.length
      if (r.kind === 'image' && headBytes < 12) continue
      fh = await openTarget(concat(head))
      for (const c of head) await writeAll(fh, c)
      head = []
    }
    if (signal.aborted) return { ok: false, why: 'failed', detail: 'timed out' }
    if (!fh) {
      fh = await openTarget(concat(head))
      for (const c of head) await writeAll(fh, c)
    }
    await fh.close()
    fh = undefined
    if (signal.aborted) return { ok: false, why: 'failed', detail: 'timed out' }
    saved = true
    return { ok: true, path: path! }
  } catch (err) {
    return { ok: false, why: 'failed', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    signal.removeEventListener('abort', stop)
    if (fh) await fh.close().catch(() => {})
    if (!saved && path) await unlink(path).catch(() => {})
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
}

async function writeAll(fh: FileHandle, chunk: Uint8Array): Promise<void> {
  let off = 0
  while (off < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, off, chunk.length - off)
    off += bytesWritten
  }
}

/**
 * Read at most `max` bytes of a stream as text, then stop it — for an HTTP
 * error body. When `signal` fires (or already has) it returns at once with
 * what it has, whether or not the stream ever ends.
 */
export async function readPrefix(
  stream: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
  max: number,
  signal?: AbortSignal,
): Promise<string> {
  const parts: Uint8Array[] = []
  const stop = () => stream.destroy?.(new Error('stopped'))
  const text = () => Buffer.concat(parts).subarray(0, max).toString('utf8')
  if (signal?.aborted) {
    stop()
    return text()
  }
  let onAbort = () => {}
  const aborted = new Promise<void>(res => {
    onAbort = () => res()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  const read = (async () => {
    let n = 0
    try {
      for await (const chunk of stream) {
        parts.push(chunk)
        n += chunk.length
        if (n >= max) break
      }
    } catch {
      // Whatever arrived before the error is still worth parsing.
    }
  })()
  try {
    await Promise.race([read, aborted])
  } finally {
    signal?.removeEventListener('abort', onAbort)
    stop()
  }
  return text()
}
