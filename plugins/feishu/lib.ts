/**
 * Pure helpers for the Feishu / Lark channel: access gating, mention
 * detection, content parsing, verdict parsing, chunking.
 *
 * No I/O and no module-level state here — server.ts owns the Feishu client,
 * the MCP connection and access.json persistence; the tests import only this
 * file (server.ts exits at import time without credentials).
 */

import { randomBytes, randomInt } from 'crypto'

export type PendingEntry = {
  senderId: string // open_id
  chatId: string // p2p chat_id — where to send the approval confirm
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

/** A sender dropped in a configured group because they're not on any list. */
export type SeenSender = {
  chatId: string
  name?: string
  lastAt: number
  count: number
}

/** An unconfigured group where someone mentioned the bot. */
export type SeenGroup = {
  name?: string
  lastAt: number
  count: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  /** open_ids allowed to trigger the bot from a p2p chat. */
  allowFrom: string[]
  /**
   * open_ids that receive permission prompts and reply-approval requests.
   * Only their verdicts, sent from their own p2p chat, count. An approver's
   * p2p chat is treated as if they were in allowFrom.
   */
  approvers: string[]
  /** Keyed on group chat_id (oc_...). */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  /** Keyed on open_id. */
  seen: Record<string, SeenSender>
  /** Keyed on chat_id. */
  seenGroups: Record<string, SeenGroup>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in server.ts
  /** Replies to anything but an approver's own p2p chat wait for an approver. Default: true. */
  requireReplyApproval?: boolean
  /** Which chunks quote the reply_to message. Default: 'first'. 'off' = never quote. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 4000, capped at 30000. */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. Default: 'newline'. */
  chunkMode?: 'length' | 'newline'
  /**
   * Auto-send ("sleep") mode: until this ms timestamp, replies that would
   * need approval are posted directly (and copied to the approvers). 0 or
   * absent = off. Toggled only by an approver from their p2p chat.
   */
  autoApproveUntil?: number
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    approvers: [],
    groups: {},
    pending: {},
    seen: {},
    seenGroups: {},
  }
}

/** Fill defaults for a parsed access.json. Unknown keys are dropped. */
export function normalizeAccess(parsed: Partial<Access>): Access {
  return {
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    approvers: parsed.approvers ?? [],
    groups: parsed.groups ?? {},
    pending: parsed.pending ?? {},
    seen: parsed.seen ?? {},
    seenGroups: parsed.seenGroups ?? {},
    mentionPatterns: parsed.mentionPatterns,
    requireReplyApproval: parsed.requireReplyApproval,
    replyToMode: parsed.replyToMode,
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode,
    autoApproveUntil: validAutoUntil(parsed.autoApproveUntil),
  }
}

export const PAIRING_TTL_MS = 60 * 60 * 1000 // 1h
export const MAX_PENDING_PAIRINGS = 3
export const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d
export const SEEN_SENDERS_CAP = 50
export const SEEN_GROUPS_CAP = 20

/** Drop expired pairing codes and stale seen / seenGroups entries. */
export function pruneAccess(a: Access, now: number): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  for (const rec of [a.seen, a.seenGroups] as Record<string, { lastAt: number }>[]) {
    for (const [k, v] of Object.entries(rec)) {
      if (v.lastAt + SEEN_TTL_MS < now) {
        delete rec[k]
        changed = true
      }
    }
  }
  return changed
}

// Keep at most `cap` entries, evicting the least recently seen.
function capByLastAt(rec: Record<string, { lastAt: number }>, cap: number): void {
  const keys = Object.keys(rec)
  if (keys.length <= cap) return
  keys.sort((x, y) => rec[x]!.lastAt - rec[y]!.lastAt)
  for (const k of keys.slice(0, keys.length - cap)) delete rec[k]
}

export function recordSeenSender(a: Access, openId: string, chatId: string, now: number): void {
  const prev = a.seen[openId]
  a.seen[openId] = { ...prev, chatId, lastAt: now, count: (prev?.count ?? 0) + 1 }
  capByLastAt(a.seen, SEEN_SENDERS_CAP)
}

export function recordSeenGroup(a: Access, chatId: string, now: number): void {
  const prev = a.seenGroups[chatId]
  a.seenGroups[chatId] = { ...prev, lastAt: now, count: (prev?.count ?? 0) + 1 }
  capByLastAt(a.seenGroups, SEEN_GROUPS_CAP)
}

// Subset of the im.message.receive_v1 event the gate and parser look at.
// Field names follow @larksuiteoapi/node-sdk's IHandles typing.
export type FeishuMention = {
  key: string
  id: { open_id?: string; user_id?: string; union_id?: string }
  name: string
  mentioned_type?: string
}

export type FeishuMessageEvent = {
  sender: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string }
    sender_type: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    thread_id?: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
    create_time: string
    mentions?: FeishuMention[]
  }
}

/**
 * Does this message address the bot? A structured @bot, a reply to one of
 * our recent messages, or a mentionPatterns hit. @all never counts.
 */
export function isMentioned(
  ev: FeishuMessageEvent,
  botOpenId: string | undefined,
  recentSentIds: ReadonlySet<string>,
  patterns: string[] | undefined,
  text: string,
): boolean {
  if (botOpenId) {
    for (const m of ev.message.mentions ?? []) {
      if (m.key === '@_all') continue
      if (m.id?.open_id === botOpenId) return true
    }
  }
  const parent = ev.message.parent_id
  if (parent && recentSentIds.has(parent)) return true
  for (const pat of patterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

export type DropNote = { kind: 'sender'; openId: string; chatId: string } | { kind: 'group'; chatId: string }

export type GateResult =
  | { action: 'deliver'; changed: boolean }
  | { action: 'drop'; changed: boolean; noted?: DropNote }
  | { action: 'pair'; code: string; isResend: boolean; changed: boolean }

export type GateContext = {
  botOpenId: string | undefined
  recentSentIds: ReadonlySet<string>
  now: number
  /** Parsed message text — matched against mentionPatterns. */
  text: string
  /** 6 hex chars. Injected so tests are deterministic. */
  newPairingCode: () => string
}

/**
 * Decide what to do with an inbound message. Mutates `access` (pruning,
 * pairing codes, seen / seenGroups records) and reports `changed` so the
 * caller can persist it.
 */
export function gate(access: Access, ev: FeishuMessageEvent, ctx: GateContext): GateResult {
  let changed = pruneAccess(access, ctx.now)

  if (access.dmPolicy === 'disabled') return { action: 'drop', changed }

  const senderId = ev.sender.sender_id?.open_id
  if (!senderId) return { action: 'drop', changed }
  const chatId = ev.message.chat_id

  if (ev.message.chat_type === 'p2p') {
    if (access.allowFrom.includes(senderId) || access.approvers.includes(senderId)) {
      return { action: 'deliver', changed }
    }
    if (access.dmPolicy === 'allowlist') return { action: 'drop', changed }

    // pairing mode — check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Reply twice max (initial + one reminder), then go silent.
        if ((p.replies ?? 1) >= 2) return { action: 'drop', changed }
        p.replies = (p.replies ?? 1) + 1
        return { action: 'pair', code, isResend: true, changed: true }
      }
    }
    // Cap pending at 3. Extra attempts are silently dropped.
    if (Object.keys(access.pending).length >= MAX_PENDING_PAIRINGS) return { action: 'drop', changed }

    const code = ctx.newPairingCode()
    access.pending[code] = {
      senderId,
      chatId, // p2p chat_id — used later to confirm approval
      createdAt: ctx.now,
      expiresAt: ctx.now + PAIRING_TTL_MS,
      replies: 1,
    }
    return { action: 'pair', code, isResend: false, changed: true }
  }

  // Every non-p2p chat_type is treated as a group, keyed on chat_id.
  const mentioned = isMentioned(ev, ctx.botOpenId, ctx.recentSentIds, access.mentionPatterns, ctx.text)
  const policy = access.groups[chatId]
  if (!policy) {
    if (!mentioned) return { action: 'drop', changed }
    recordSeenGroup(access, chatId, ctx.now)
    return { action: 'drop', changed: true, noted: { kind: 'group', chatId } }
  }
  const requireMention = policy.requireMention ?? true
  if (requireMention && !mentioned) return { action: 'drop', changed }

  // Unlike Discord, an empty group allowFrom does NOT mean "any member":
  // the sender must be on the group list, the global list, or an approver.
  const allowed =
    (policy.allowFrom ?? []).includes(senderId) ||
    access.allowFrom.includes(senderId) ||
    access.approvers.includes(senderId)
  if (!allowed) {
    if (!mentioned) return { action: 'drop', changed }
    recordSeenSender(access, senderId, chatId, ctx.now)
    return { action: 'drop', changed: true, noted: { kind: 'sender', openId: senderId, chatId } }
  }
  return { action: 'deliver', changed }
}

// Replace @_user_N / @_all placeholders. The bot's own placeholder is removed.
function replaceMentionKeys(s: string, mentions: FeishuMention[], botOpenId: string | undefined): string {
  const byKey = new Map(mentions.map(m => [m.key, m]))
  return s.replace(/@_user_\d+|@_all/g, key => {
    if (key === '@_all') return '@all'
    const m = byKey.get(key)
    if (!m) return key
    if (botOpenId && m.id?.open_id === botOpenId) return ''
    // Display names are attacker-controlled — sanitize like any other name.
    return `@${sanitizeName(m.name) ?? 'user'}`
  })
}

type PostElement = {
  tag?: string
  text?: string
  href?: string
  user_id?: string
  user_name?: string
}

// Feishu auto-links emails and URLs typed into a message: "a@b.com" arrives as
// { text: 'a@b.com', href: 'mailto:a@b.com' }, "x.cn" as href 'https://x.cn/'.
// Printing those as "text (href)" corrupts pasted curl commands and JSON
// bodies, so a link whose href is just its text plus scheme / trailing slash
// prints as the text alone.
export function isAutoLink(text: string, href: string): boolean {
  const norm = (s: string) =>
    s.trim().replace(/^(mailto:|tel:|https?:\/\/)/i, '').replace(/\/+$/, '').toLowerCase()
  return norm(text) === norm(href)
}

function postElementText(
  el: PostElement,
  byKey: Map<string, FeishuMention>,
  botOpenId: string | undefined,
): string {
  switch (el?.tag) {
    case 'text':
    case 'md':
    case 'code_block':
      return typeof el.text === 'string' ? el.text : ''
    case 'a': {
      const text = el.text ?? ''
      const href = el.href ?? ''
      if (text && href && !isAutoLink(text, href)) return `${text} (${href})`
      return text || href
    }
    case 'at': {
      const uid = el.user_id ?? ''
      if (uid === 'all' || uid === '@_all') return '@all'
      const m = byKey.get(uid)
      if (botOpenId && (uid === botOpenId || m?.id?.open_id === botOpenId)) return ''
      const name = sanitizeName(el.user_name || m?.name || uid)
      return name ? `@${name}` : ''
    }
    // Not downloaded in this version, but say they were there so Claude can
    // ask for the details instead of reasoning as if the text were all.
    case 'img':
      return '[图片]'
    case 'media':
      return '[视频]'
    default:
      return ''
  }
}

type PostBody = { title?: string; content: PostElement[][] }

// Received posts carry { title, content } at the top level; the send-side
// format wraps that in a locale key ({ zh_cn: { ... } }). Accept both.
function findPostBody(obj: unknown): PostBody | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Record<string, unknown>
  if (Array.isArray(o.content)) return o as unknown as PostBody
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).content)) {
      return v as PostBody
    }
  }
  return undefined
}

/**
 * Flatten a message's content to plain text. Never throws — unparseable
 * content becomes "(unparseable <type> message)", non-text types become
 * "(<type> message)".
 */
export function parseContent(
  messageType: string,
  content: string,
  mentions: FeishuMention[] | undefined,
  botOpenId: string | undefined,
): string {
  const ms = mentions ?? []
  try {
    if (messageType === 'text') {
      const text = (JSON.parse(content) as { text?: unknown }).text
      if (typeof text !== 'string') throw new Error('no text')
      return replaceMentionKeys(text, ms, botOpenId).trim()
    }
    if (messageType === 'post') {
      const body = findPostBody(JSON.parse(content))
      if (!body) throw new Error('no post body')
      const byKey = new Map(ms.map(m => [m.key, m]))
      const lines: string[] = []
      if (typeof body.title === 'string' && body.title) lines.push(body.title)
      for (const para of body.content) {
        if (!Array.isArray(para)) continue
        const line = para.map(el => postElementText(el, byKey, botOpenId)).join('')
        // "@bot rest" — drop the space the removed @bot leaves behind.
        const leadingBotAt = para[0]?.tag === 'at' && postElementText(para[0], byKey, botOpenId) === ''
        lines.push(leadingBotAt ? line.trimStart() : line)
      }
      return replaceMentionKeys(lines.join('\n'), ms, botOpenId).trim()
    }
  } catch {
    return `(unparseable ${messageType} message)`
  }
  return `(${messageType} message)`
}

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// Reply-approval verdict: "ok <code>" posts the draft, "n|no <code> [reason]"
// discards it. y/yes never approve a draft — they're for permission prompts
// only, so a reply code and a permission id can't be confused for each other.
// Only honored when the code is a pending (or recently handled) reply.
export const REPLY_APPROVAL_RE = /^\s*(ok|n|no)\s+([a-km-z]{5})(?:\s+([\s\S]*\S))?\s*$/i

export type Verdict =
  | { kind: 'reply'; approve: boolean; code: string; reason?: string }
  /** ok/no for a reply code that was already posted, discarded or expired-by-handling. */
  | { kind: 'reply-handled'; code: string }
  /** y/yes aimed at a reply code — tell the approver to use "ok". */
  | { kind: 'reply-misuse'; code: string }
  | { kind: 'permission'; request_id: string; behavior: 'allow' | 'deny' }

export type VerdictOptions = {
  chatType: string
  isApprover: boolean
  hasPendingReply: (code: string) => boolean
  /** Reply codes handled recently (posted or discarded). */
  wasReplyHandled?: (code: string) => boolean
  /** Permission request_ids Claude Code sent recently. */
  isPermissionId?: (id: string) => boolean
}

/**
 * Interpret a delivered message as an approver verdict. Only an approver's
 * own p2p chat can produce one; anything else (including the same text in a
 * group) is an ordinary message and this returns null.
 */
export function parseVerdict(text: string, opts: VerdictOptions): Verdict | null {
  if (opts.chatType !== 'p2p' || !opts.isApprover) return null
  const handled = opts.wasReplyHandled ?? (() => false)

  const r = REPLY_APPROVAL_RE.exec(text)
  if (r) {
    const code = r[2]!.toLowerCase()
    if (opts.hasPendingReply(code)) {
      const word = r[1]!.toLowerCase()
      return { kind: 'reply', approve: word === 'ok', code, ...(r[3] ? { reason: r[3] } : {}) }
    }
    if (handled(code)) return { kind: 'reply-handled', code }
  }

  const p = PERMISSION_REPLY_RE.exec(text)
  if (p) {
    const id = p[2]!.toLowerCase()
    const yes = p[1]!.toLowerCase().startsWith('y')
    // "yes <reply code>" can only be a mistaken draft approval — unless the
    // id really is a live permission request (codes avoid those, but Claude
    // Code picks its ids independently).
    if (yes && !opts.isPermissionId?.(id) && (opts.hasPendingReply(id) || handled(id))) {
      return { kind: 'reply-misuse', code: id }
    }
    return { kind: 'permission', request_id: id, behavior: yes ? 'allow' : 'deny' }
  }
  return null
}

const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz' // a-z minus 'l'

/** A 5-letter [a-km-z] code that `taken` rejects is never returned. */
export function newApprovalCode(taken: (code: string) => boolean): string {
  for (;;) {
    let code = ''
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    if (!taken(code)) return code
  }
}

/** Insert into an insertion-ordered set, dropping the oldest past `cap`. */
export function noteBounded<T>(set: Set<T>, value: T, cap: number): void {
  set.add(value)
  while (set.size > cap) {
    // Sets iterate in insertion order — this drops the oldest.
    const first = set.values().next().value as T
    set.delete(first)
  }
}

const ZWSP = String.fromCharCode(0x200b) // zero-width space

// Feishu text messages interpret some markup: <at user_id="all"> pings
// everyone, and tags / [link](url) / **bold** may render differently from the
// literal text the approver reviewed. Outbound text is meant literally, so a
// zero-width space breaks every such sequence: after '<' when a letter or '/'
// follows (any tag), between ']' and '(', and between adjacent '*'. It looks
// the same, and what gets posted is exactly what the approver saw.
export function neutralizeMarkup(text: string): string {
  return text
    .replace(/<(?=[A-Za-z/])/g, `<${ZWSP}`)
    .replace(/\](?=\()/g, `]${ZWSP}`)
    .replace(/\*(?=\*)/g, `*${ZWSP}`)
}

const REDACTED = '[REDACTED]'

/**
 * Strip credentials from a log line or outbound text: the literal values in
 * `secrets` (the app secret), Bearer tokens, "app_secret":"..." pairs, and
 * tenant-token-shaped strings (t-...).
 */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text
  for (const s of secrets) {
    if (s) out = out.split(s).join(REDACTED)
  }
  return out
    .replace(/Bearer\s+\S+/g, REDACTED)
    .replace(/"app_secret"\s*:\s*"[^"]*"/g, REDACTED)
    .replace(/\bt-[A-Za-z0-9._-]{10,}/g, REDACTED)
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// axios errors (and anything shaped like one) carry the full request config —
// headers with the tenant token, bodies with the app secret or a reply draft.
function isRequestErrorLike(v: object): boolean {
  return 'config' in v || 'isAxiosError' in v || 'response' in v
}

function formatOne(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    if (isRequestErrorLike(v)) {
      const o = v as { message?: unknown; response?: { data?: unknown } }
      const data = o.response?.data as { code?: unknown; msg?: unknown } | undefined
      const feishu =
        data && typeof data === 'object' && (data.code !== undefined || data.msg !== undefined)
          ? ` (feishu code ${String(data.code)}: ${String(data.msg ?? '')})`
          : ''
      return `${typeof o.message === 'string' ? o.message : 'request failed'}${feishu}`
    }
    if (v instanceof Error) return v.message
  }
  return safeJson(v)
}

function flattenArgs(parts: unknown[], out: unknown[] = []): unknown[] {
  for (const p of parts) {
    if (Array.isArray(p)) flattenArgs(p, out)
    else out.push(p)
  }
  return out
}

/**
 * Format SDK logger arguments into one safe line. The SDK's LoggerProxy hands
 * the custom logger its argument list as a single array, so arrays are
 * flattened first; request errors are reduced to message + Feishu code/msg;
 * the whole line is then redacted.
 */
export function formatLogArgs(parts: unknown[], secrets: readonly (string | undefined)[]): string {
  return redact(flattenArgs(parts).map(formatOne).join(' '), secrets)
}

export const NAME_MAX_CHARS = 40

/**
 * Names come from Feishu (user or group names) — attacker-controlled text.
 * Drop control / format characters (newlines, bidi overrides, zero-widths),
 * turn double quotes into single so a name can't close the quotes it's shown
 * in, collapse whitespace, cap at 40 characters.
 */
export function sanitizeName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined
  const clean = name
    // Cc = controls incl. newlines, Cf = format chars (bidi overrides,
    // zero-widths); U+2028/2029 are caught by \s below.
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/["“”＂]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  const capped = [...clean].slice(0, NAME_MAX_CHARS).join('')
  return capped || undefined
}

/** Approval-request target line: 群 "<name>"（<chat_id>） / 私聊 "<name>"（<open_id>）. */
export function approvalTargetLabel(t: { kind: 'group' | 'p2p'; id: string; name?: string }): string {
  const kind = t.kind === 'group' ? '群' : '私聊'
  const name = sanitizeName(t.name)
  return name ? `${kind} "${name}"（${t.id}）` : `${kind} ${t.id}`
}

export const DRAFT_LINE_PREFIX = '┃ '

/**
 * Split an approval request into messages. Every draft line is prefixed with
 * "┃ " (long lines are hard-split and each piece prefixed), so nothing in the
 * draft can pass for the header or the closing instructions. The code appears
 * only in the closing instructions of the last message; earlier messages say
 * which part they are, so an approver who misses the last part never has the
 * code.
 */
export function buildApprovalNotice(
  opts: {
    target: string
    replyTo?: string
    text: string
    code: string
    limit: number
  },
  secrets: Secrets,
): string[] {
  const tail =
    `—— 草稿结束 ——\n` +
    `回复 "ok ${opts.code}" 发送，"no ${opts.code} [理由]" 丢弃`
  // Redact the whole draft before splitting: a secret cut in two by a
  // segment boundary would slip past a per-segment redact.
  const segments = packDraft(draftHeader(opts.target, opts.replyTo), redact(opts.text, secrets), tail, opts.limit)
  const n = segments.length
  if (n === 1) return segments
  return segments.map((s, i) =>
    i < n - 1 ? `（第 ${i + 1}/${n} 段，审批码在最后一段）\n${s}` : `（第 ${n}/${n} 段）\n${s}`,
  )
}

/**
 * The draft as plain-text messages for a reply too long for a card. No code
 * and no closing instructions: the approval card sent after them carries the
 * buttons and the code. Every segment says so.
 */
export function buildDraftSegments(
  opts: { target: string; replyTo?: string; text: string; limit: number },
  secrets: Secrets,
): string[] {
  const segments = packDraft(
    draftHeader(opts.target, opts.replyTo),
    redact(opts.text, secrets), // whole text first, then split (see buildApprovalNotice)
    '—— 草稿结束 ——',
    opts.limit,
  )
  const n = segments.length
  return segments.map((s, i) => `（第 ${i + 1}/${n} 段，审批按钮在随后的卡片里）\n${s}`)
}

function draftHeader(target: string, replyTo: string | undefined): string {
  return (
    `📝 待审批回复\n目标：${target}\n` +
    (replyTo ? `引用消息：${replyTo}\n` : '') +
    `以下是草稿原文，每行以 "${DRAFT_LINE_PREFIX.trim()}" 开头：`
  )
}

// Header, "┃ "-prefixed draft lines (long lines hard-split, each piece
// prefixed), tail — greedily packed on line boundaries into segments that
// leave room for a part marker.
function packDraft(header: string, text: string, tail: string, limit: number): string[] {
  const MARKER_ROOM = 40
  const room = Math.max(20, limit - MARKER_ROOM)

  const pieceLen = Math.max(1, room - DRAFT_LINE_PREFIX.length)
  const lines: string[] = [header]
  for (const line of text.split('\n')) {
    const chars = [...line]
    if (chars.length === 0) lines.push(DRAFT_LINE_PREFIX)
    for (let i = 0; i < chars.length; i += pieceLen) {
      lines.push(DRAFT_LINE_PREFIX + chars.slice(i, i + pieceLen).join(''))
    }
  }
  lines.push(tail)

  const segments: string[] = []
  let cur = ''
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line
    if (cur && next.length > room) {
      segments.push(cur)
      cur = line
    } else {
      cur = next
    }
  }
  if (cur) segments.push(cur)
  return segments
}

// ---------------------------------------------------------------------------
// Interactive approval cards (Feishu card JSON 2.0).
//
// Every piece of text from outside (tool input, Claude's draft, names) goes
// into a `plain_text` element, which the card renderer doesn't parse for
// Markdown or <at> tags (only `lark_md` does). It is still redacted, and
// neutralizeMarkup is applied as well — zero-width spaces are invisible, and
// the card then shows exactly what the text path would post.

export type CardKind = 'perm' | 'reply'
export type CardDecision = 'allow' | 'deny'
/** Button callback payload. Short keys: k = kind, id = 5-letter code, a = decision. */
export type CardButtonValue = { k: CardKind; id: string; a: CardDecision }

/** Serialized card content must stay under Feishu's 30 KB card limit; keep headroom for its own overhead. */
export const CARD_MAX_BYTES = 25 * 1024

export type PermissionCardView = {
  kind: 'perm'
  id: string
  toolName: string
  description: string
  inputPreview: string
}

export type ReplyCardView = {
  kind: 'reply'
  id: string
  target: string
  replyTo?: string
  /** Full draft — or omitted when it was sent as `draftSegments` text messages first. */
  text?: string
  draftSegments?: number
}

export type CardView = PermissionCardView | ReplyCardView

/** pending → buttons; done → no buttons, one result line. */
export type CardState = { status: 'pending' } | { status: 'done'; result: string }

type Secrets = readonly (string | undefined)[]

function cardText(s: string, secrets: Secrets): string {
  return neutralizeMarkup(redact(s, secrets))
}

function plainDiv(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'plain_text', content, ...extra } }
}

function button(label: string, type: string, value: CardButtonValue): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value }],
  }
}

function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

export function buildApprovalCard(view: CardView, state: CardState, secrets: Secrets): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  let title: string
  let labels: [string, string]
  let hint: string
  if (view.kind === 'perm') {
    title = '🔐 Claude 请求执行工具'
    elements.push(plainDiv(`工具：${cardText(view.toolName, secrets)}`))
    elements.push(plainDiv(`说明：${cardText(view.description, secrets)}`))
    elements.push(plainDiv(`输入：\n${cardText(prettyInput(view.inputPreview), secrets)}`))
    labels = ['允许', '拒绝']
    hint = `也可回复 yes ${view.id} / no ${view.id}`
  } else {
    title = `📝 待发送到 ${cardText(view.target, secrets)}`
    if (view.replyTo) elements.push(plainDiv(`引用消息：${cardText(view.replyTo, secrets)}`))
    if (view.draftSegments) {
      elements.push(plainDiv(`草稿见上方 ${view.draftSegments} 段文字消息（每行以 "┃" 开头）。`))
    } else {
      elements.push(plainDiv(cardText(view.text ?? '', secrets)))
    }
    labels = ['发送', '丢弃']
    hint = `也可回复 ok ${view.id} 发送，no ${view.id} [理由] 丢弃并说明理由`
  }

  if (state.status === 'pending') {
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      columns: [
        { tag: 'column', width: 'auto', elements: [button(labels[0], 'primary', { k: view.kind, id: view.id, a: 'allow' })] },
        { tag: 'column', width: 'auto', elements: [button(labels[1], 'danger', { k: view.kind, id: view.id, a: 'deny' })] },
      ],
    })
    elements.push(plainDiv(hint, { text_color: 'grey', text_size: 'notation' }))
  } else {
    elements.push(plainDiv(state.result))
  }

  return {
    schema: '2.0',
    // update_multi: required for later PATCH updates to reach every recipient
    // (and the only value card JSON 2.0 allows anyway).
    config: { update_multi: true, summary: { content: title } },
    header: {
      title: { tag: 'plain_text', content: title },
      template: state.status === 'pending' ? (view.kind === 'perm' ? 'orange' : 'blue') : 'grey',
    },
    body: { elements },
  }
}

/** The `content` string to send / patch, or null when it would exceed CARD_MAX_BYTES. */
export function serializeCard(card: Record<string, unknown>): string | null {
  const content = JSON.stringify(card)
  // The request body embeds content as a JSON string, escaping it once more.
  return Buffer.byteLength(JSON.stringify(content), 'utf8') <= CARD_MAX_BYTES ? content : null
}

const CODE_RE = /^[a-km-z]{5}$/

/** Auto-send control card button: exactly { k: 'auto', a }. */
export type AutoButtonValue = { k: 'auto'; a: 'on' | 'off' }

export type CardActionParse =
  | { ok: false; reason: 'disabled' | 'not-approver' | 'bad-value' }
  | { ok: true; operator: string; messageId?: string; chatId?: string; value: CardButtonValue | AutoButtonValue }

/**
 * Validate a card.action.trigger callback (SDK-flattened: operator / action /
 * context at the top level). Only an approver's click counts, and the value
 * must be exactly { k, id, a } with fixed k / a and a 5-letter [a-km-z] id,
 * or exactly { k: 'auto', a: 'on' | 'off' } — anything else is rejected.
 */
export function parseCardAction(
  raw: unknown,
  approvers: readonly string[],
  opts: { disabled?: boolean } = {},
): CardActionParse {
  // dmPolicy "disabled" turns the whole channel off — buttons included,
  // same as the text path (gate drops everything).
  if (opts.disabled) return { ok: false, reason: 'disabled' }
  const ev = (raw && typeof raw === 'object' ? raw : {}) as {
    operator?: { open_id?: unknown }
    action?: { value?: unknown }
    context?: { open_message_id?: unknown; open_chat_id?: unknown }
    open_message_id?: unknown
    open_chat_id?: unknown
  }
  const operator = ev.operator?.open_id
  if (typeof operator !== 'string' || !approvers.includes(operator)) return { ok: false, reason: 'not-approver' }

  let value: unknown = ev.action?.value
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, reason: 'bad-value' }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'bad-value' }
  const v = value as Record<string, unknown>
  const keys = Object.keys(v).sort().join(',')
  let parsed: CardButtonValue | AutoButtonValue
  if (v.k === 'auto') {
    if (keys !== 'a,k') return { ok: false, reason: 'bad-value' }
    if (v.a !== 'on' && v.a !== 'off') return { ok: false, reason: 'bad-value' }
    parsed = { k: 'auto', a: v.a }
  } else {
    if (keys !== 'a,id,k') return { ok: false, reason: 'bad-value' }
    if (v.k !== 'perm' && v.k !== 'reply') return { ok: false, reason: 'bad-value' }
    if (v.a !== 'allow' && v.a !== 'deny') return { ok: false, reason: 'bad-value' }
    if (typeof v.id !== 'string' || !CODE_RE.test(v.id)) return { ok: false, reason: 'bad-value' }
    parsed = { k: v.k, id: v.id, a: v.a }
  }

  const messageId = ev.context?.open_message_id ?? ev.open_message_id
  const chatId = ev.context?.open_chat_id ?? ev.open_chat_id
  return {
    ok: true,
    operator,
    ...(typeof messageId === 'string' ? { messageId } : {}),
    ...(typeof chatId === 'string' ? { chatId } : {}),
    value: parsed,
  }
}

export type CardRoute =
  | { route: 'permission-verdict'; requestId: string; behavior: CardDecision }
  | { route: 'permission-handled'; requestId: string }
  | { route: 'reply-verdict'; code: string; approve: boolean }
  | { route: 'reply-handled'; code: string }
  | { route: 'reply-expired'; code: string }

/** Where a validated button click goes: k = perm → permission path, k = reply → reply-approval path. */
export function routeCardAction(
  value: CardButtonValue,
  state: {
    hasPendingReply: (code: string) => boolean
    wasReplyHandled: (code: string) => boolean
    wasPermissionHandled: (id: string) => boolean
  },
): CardRoute {
  if (value.k === 'perm') {
    return state.wasPermissionHandled(value.id)
      ? { route: 'permission-handled', requestId: value.id }
      : { route: 'permission-verdict', requestId: value.id, behavior: value.a }
  }
  if (state.hasPendingReply(value.id)) return { route: 'reply-verdict', code: value.id, approve: value.a === 'allow' }
  if (state.wasReplyHandled(value.id)) return { route: 'reply-handled', code: value.id }
  return { route: 'reply-expired', code: value.id }
}

/** Result line shown on a handled card. */
export function cardResultLine(kind: CardKind, decision: CardDecision): string {
  if (kind === 'perm') return decision === 'allow' ? '✅ 已允许' : '❌ 已拒绝'
  return decision === 'allow' ? '✅ 已批准，发送中' : '🗑 已丢弃'
}

// ---------------------------------------------------------------------------
// Auto-send ("sleep") mode.

export const AUTO_DEFAULT_HOURS = 8
export const AUTO_MAX_HOURS = 72
const HOUR_MS = 60 * 60 * 1000

export type AutoCommand =
  | { cmd: 'on'; hours: number }
  | { cmd: 'off' }
  | { cmd: 'status' }
  /** Looked like an auto command but the argument is invalid — answer with usage, change nothing. */
  | { cmd: 'usage' }

export const AUTO_USAGE =
  `用法：auto（开启 ${AUTO_DEFAULT_HOURS} 小时）、auto <N>h（N 为 1–${AUTO_MAX_HOURS} 的整数）、auto off、auto status`

/**
 * Parse an approver's p2p "auto" command. The whole message must be the
 * command: "auto", "auto <N>h", "auto off", "auto status" (case-insensitive,
 * surrounding whitespace ignored). One invalid argument ("auto 0h",
 * "auto 1.5h") → usage. Anything longer ("auto 8h please", "auto tests are
 * failing") isn't a command at all — it stays an ordinary message, as does
 * everything from non-approvers or in groups.
 */
export function parseAutoCommand(text: string, opts: { chatType: string; isApprover: boolean }): AutoCommand | null {
  if (opts.chatType !== 'p2p' || !opts.isApprover) return null
  const m = /^auto(?:\s+(\S+))?$/i.exec(text.trim())
  if (!m) return null
  const arg = m[1]?.toLowerCase()
  if (arg === undefined) return { cmd: 'on', hours: AUTO_DEFAULT_HOURS }
  if (arg === 'off') return { cmd: 'off' }
  if (arg === 'status') return { cmd: 'status' }
  const h = /^(\d{1,3})h$/.exec(arg)
  if (h) {
    const hours = Number(h[1])
    if (Number.isInteger(hours) && hours >= 1 && hours <= AUTO_MAX_HOURS) return { cmd: 'on', hours }
  }
  return { cmd: 'usage' }
}

export function autoUntil(now: number, hours: number): number {
  return now + hours * HOUR_MS
}

export const AUTO_WRITE_FAILED = '设置失败，access.json 当前不可写'

/**
 * Apply an auto command to `access` and persist it with `save` (false = the
 * write didn't happen, e.g. access.json unreadable). Returns ok + the note
 * for the status card. Drafts already pending stay pending — the note says
 * how many.
 */
export const AUTO_FORCED_OFF_NOTE = '已在本进程关闭，但 access.json 不可写，重启后可能恢复，请修复文件'

/**
 * Apply an auto command to `access` and persist it with `save` (false = the
 * write didn't happen, e.g. access.json unreadable). Returns ok + the note
 * for the status card. Drafts already pending stay pending — the note says
 * how many.
 *
 * `forcedOff` tells the caller how to set its in-process "forced off" flag
 * (undefined = leave it): an `auto off` that can't be written still turns
 * auto-send off for this process (true); any successful write clears it.
 */
export function applyAutoCommandTo(
  access: Access,
  cmd: AutoCommand,
  opts: { now: number; save: (a: Access) => boolean; pendingCount: number },
): { ok: boolean; note?: string; forcedOff?: boolean } {
  if (cmd.cmd === 'usage') return { ok: false, note: AUTO_USAGE }
  if (cmd.cmd === 'status') return { ok: true }
  const before = access.autoApproveUntil
  access.autoApproveUntil = cmd.cmd === 'on' ? autoUntil(opts.now, cmd.hours) : 0
  if (!opts.save(access)) {
    access.autoApproveUntil = before
    if (cmd.cmd === 'off') return { ok: true, note: AUTO_FORCED_OFF_NOTE, forcedOff: true }
    return { ok: false, note: AUTO_WRITE_FAILED }
  }
  if (cmd.cmd === 'off') return { ok: true, note: '已关闭，之后的回复恢复审批', forcedOff: false }
  return {
    ok: true,
    forcedOff: false,
    note:
      `已开启 ${cmd.hours} 小时` +
      (opts.pendingCount > 0 ? `；还有 ${opts.pendingCount} 条草稿等你审批（开启前提交的仍需审批）` : ''),
  }
}

/** Longest valid auto-send window from "now", with slack for clock skew / slow writes. */
export const AUTO_MAX_AHEAD_MS = AUTO_MAX_HOURS * HOUR_MS + 5 * 60 * 1000

/** access.json value → a finite, non-negative number (anything else = 0 = off). */
export function validAutoUntil(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** A stored end time further out than any command could set (> now + 72h + 5min) — treated as off. */
export function autoUntilTooFar(until: number | undefined, now: number): boolean {
  return (until ?? 0) > now + AUTO_MAX_AHEAD_MS
}

export function isAutoActive(access: Pick<Access, 'autoApproveUntil'>, now: number): boolean {
  const until = validAutoUntil(access.autoApproveUntil)
  return until > 0 && now < until && !autoUntilTooFar(until, now)
}

/**
 * How the reply tool treats a send:
 * - 'direct': no approval wanted (requireReplyApproval false, or an approver's own p2p chat)
 * - 'auto': approval would be needed, but auto-send mode is on — post and copy the approvers
 * - 'approval': hold for an approver
 */
export function replyApprovalMode(
  access: Pick<Access, 'requireReplyApproval' | 'approvers' | 'autoApproveUntil'>,
  p2pUser: string | undefined,
  now: number,
): 'direct' | 'auto' | 'approval' {
  if (access.requireReplyApproval === false) return 'direct'
  if (p2pUser !== undefined && access.approvers.includes(p2pUser)) return 'direct'
  // No approver → nobody to copy and nobody who could have switched it on:
  // never auto, fall through to approval ("no approver configured").
  if (access.approvers.length === 0) return 'approval'
  return isAutoActive(access, now) ? 'auto' : 'approval'
}

/**
 * Expiry notice is due once per expiry time: the stored time has passed and
 * it isn't the one already announced. `auto off` stores 0, so a manual close
 * never produces an expiry notice.
 */
export function autoExpiryDue(until: number | undefined, now: number, announcedFor: number | undefined): boolean {
  return !!until && until > 0 && now >= until && announcedFor !== until
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** "开启，到 10-23 07:30（剩余 7 小时 59 分）" / "关闭" — local time of the server. */
export function describeAuto(until: number | undefined, now: number): string {
  if (!isAutoActive({ autoApproveUntil: until }, now) || !until) return '关闭'
  const d = new Date(until)
  const at = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const mins = Math.ceil((until - now) / 60000)
  const left = mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分`
  return `开启，到 ${at}（剩余 ${left}）`
}

/** The auto-send control card: status, an optional note, 开启 8 小时 / 关闭 buttons. */
export function buildAutoCard(opts: { until: number | undefined; now: number; note?: string }): Record<string, unknown> {
  const on = isAutoActive({ autoApproveUntil: opts.until }, opts.now)
  const elements: Record<string, unknown>[] = [plainDiv(`状态：${describeAuto(opts.until, opts.now)}`)]
  if (opts.note) elements.push(plainDiv(opts.note))
  elements.push({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      { tag: 'column', width: 'auto', elements: [autoButton(`开启 ${AUTO_DEFAULT_HOURS} 小时`, 'primary', 'on')] },
      { tag: 'column', width: 'auto', elements: [autoButton('关闭', 'default', 'off')] },
    ],
  })
  elements.push(
    plainDiv(
      `开启期间，发往群和他人的回复不经审批直接发出，每条都会抄送给你；Claude 的工具权限请求仍需审批。也可回复 auto / auto <N>h / auto off / auto status`,
      { text_color: 'grey', text_size: 'notation' },
    ),
  )
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: '🌙 自动发送' } },
    header: { title: { tag: 'plain_text', content: '🌙 自动发送' }, template: on ? 'indigo' : 'grey' },
    body: { elements },
  }
}

function autoButton(label: string, type: string, a: 'on' | 'off'): Record<string, unknown> {
  const value: AutoButtonValue = { k: 'auto', a }
  return { tag: 'button', type, text: { tag: 'plain_text', content: label }, behaviors: [{ type: 'callback', value }] }
}

/**
 * Copy of an auto-sent reply for the approvers: "📤 自动发送到 <target>" and
 * the text with "┃ " line prefixes, split like approval drafts, redacted.
 * (sendText neutralizes markup on the way out.)
 */
export function buildAutoSendCopy(
  opts: {
    target: string
    replyTo?: string
    /** What actually went out (all of it, or the chunks sent before a failure). */
    text: string
    limit: number
    /** Partial send: which chunk failed (1-based) of how many, and why. */
    failure?: { index: number; total: number; reason: string }
  },
  secrets: Secrets,
): string[] {
  const header =
    `📤 自动发送到 ${opts.target}\n` +
    (opts.replyTo ? `引用消息：${opts.replyTo}\n` : '') +
    `已发出的内容，每行以 "${DRAFT_LINE_PREFIX.trim()}" 开头：`
  const tail = opts.failure
    ? `—— 以上内容已发出 ——\n⚠️ 第 ${opts.failure.index}/${opts.failure.total} 段发送失败：${redact(opts.failure.reason, secrets)}，之后的内容没有发出`
    : '—— 以上内容已发出 ——'
  const segments = packDraft(header, redact(opts.text, secrets), tail, opts.limit)
  const n = segments.length
  return n === 1 ? segments : segments.map((s, i) => `（第 ${i + 1}/${n} 段）\n${s}`)
}

/** Redact the whole text, then chunk — so no secret can straddle a chunk boundary unredacted. */
export function chunkRedacted(text: string, limit: number, mode: 'length' | 'newline', secrets: Secrets): string[] {
  return chunk(redact(text, secrets), limit, mode)
}

/**
 * Fixed first line on every message Claude's reply tool posts into an
 * approver's own p2p chat, so Claude can't dress up a reply as one of the
 * plugin's approval notices / receipts. Plugin notices never carry it.
 */
export const CLAUDE_REPLY_PREFIX = '💬 Claude 回复：'

export function claudeReplyPrefix(p2pUser: string | undefined, approvers: readonly string[]): string | undefined {
  return p2pUser !== undefined && approvers.includes(p2pUser) ? CLAUDE_REPLY_PREFIX : undefined
}

/** The text body actually sent: redacted, markup neutralized, then the prefix line (added last, untouched). */
export function outboundText(text: string, secrets: Secrets, prefix?: string): string {
  const body = neutralizeMarkup(redact(text, secrets))
  return prefix ? `${prefix}\n${body}` : body
}

/**
 * Claude-facing handle for a held reply. Deliberately unrelated to the
 * approval code — Claude never learns the code, so it can't write a
 * convincing fake approval request that carries it.
 */
export function newDraftRef(): string {
  // Digits only, short prefix: nothing in it can look like an approval code
  // ([a-km-z]{5} — "draft" itself would).
  return `ref-${randomBytes(5).readUIntBE(0, 5).toString().padStart(13, '0')}`
}

export function queuedResult(ref: string): string {
  return `queued for approval (draft_ref ${ref}) — it will be posted when an approver approves it; do not call reply again for this message`
}

/** The channel notification Claude gets when a held reply is decided. */
export function replyOutcomeNotice(o: {
  ref: string
  chatId: string
  outcome: 'approved' | 'rejected' | 'failed'
  reason?: string
  error?: string
  note?: string
}): { content: string; meta: Record<string, string> } {
  const content =
    o.outcome === 'approved'
      ? `Approved reply ${o.ref} was posted to ${o.chatId}.` + (o.note ? ` (${o.note})` : '')
      : o.outcome === 'failed'
        ? `Approved reply ${o.ref} to ${o.chatId} failed to post: ${o.error ?? 'unknown error'}`
        : `Reply ${o.ref} to ${o.chatId} was rejected by the approver.` + (o.reason ? `\nReason: ${o.reason}` : '')
  return { content, meta: { chat_id: o.chatId, draft_ref: o.ref, approval: o.outcome } }
}

/** Access used when access.json can't be read and nothing good was ever loaded: drop everything. */
export function lockedDownAccess(): Access {
  return { ...defaultAccess(), dmPolicy: 'disabled' }
}

export type AccessReader = {
  /** Current access. Never throws. */
  load: () => Access
  /** False while the file is unreadable / corrupt — callers must not write it then. */
  lastReadOk: () => boolean
}

/**
 * access.json loader. `readRaw` returns the file text, or null when the file
 * doesn't exist (= defaults). A corrupt or unreadable file is left untouched:
 * the last successfully loaded access is reused (or, if there never was one,
 * a drop-everything access), a warning is logged once per failure streak, and
 * lastReadOk() turns false so nothing is written back over it.
 */
export function createAccessReader(readRaw: () => string | null, warn: (msg: string) => void): AccessReader {
  let lastGood: Access | null = null
  let ok = true
  const clone = (a: Access): Access => JSON.parse(JSON.stringify(a)) as Access
  return {
    load() {
      try {
        const raw = readRaw()
        let a: Access
        if (raw === null) {
          a = defaultAccess()
        } else {
          const parsed: unknown = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
          a = normalizeAccess(parsed as Partial<Access>)
        }
        lastGood = clone(a)
        ok = true
        return a
      } catch (err) {
        if (ok) {
          warn(
            `access.json unreadable (${err instanceof Error ? err.message : String(err)}); ` +
            (lastGood ? 'using the last good copy' : 'dropping all messages') +
            ' until it is fixed — the file is left as is',
          )
        }
        ok = false
        return lastGood ? clone(lastGood) : lockedDownAccess()
      }
    },
    lastReadOk: () => ok,
  }
}

// Split long replies, preferring paragraph boundaries when chunkMode is
// 'newline'.
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
