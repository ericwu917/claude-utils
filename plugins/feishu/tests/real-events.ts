/**
 * im.message.receive_v1 events captured from a real Feishu long connection
 * (2026-10-22). Structure is verbatim — note the flattened header fields and
 * `user_id: null` — but IDs, tenant keys and timestamps are replaced.
 */

import type { FeishuMessageEvent } from '../lib.ts'

export const REAL_BOT = 'ou_realbot0000000000000000000000'
export const REAL_USER = 'ou_realuser000000000000000000000'
export const REAL_P2P = 'oc_realp2p00000000000000000000000'
export const REAL_GROUP = 'oc_realgroup000000000000000000000'

const header = {
  schema: '2.0',
  event_id: 'evt_0000000000000000000000000000',
  token: '',
  create_time: '1761091200000',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_0000000',
  app_id: 'cli_000000000000',
}

const sender = {
  sender_id: { open_id: REAL_USER, union_id: 'on_realuser00000000000000000000', user_id: null },
  sender_type: 'user',
  tenant_key: 'tenant_0000000',
}

const botMention = {
  id: { open_id: REAL_BOT, union_id: 'on_realbot000000000000000000000', user_id: null },
  key: '@_user_1',
  mentioned_type: 'bot',
  name: 'CC 排障助手',
  tenant_key: 'tenant_0000000',
}

// The SDK types user_id as string | undefined; the wire sends null.
const cast = (v: unknown) => v as FeishuMessageEvent

/** Private chat, plain text. */
export const REAL_P2P_TEXT = cast({
  ...header,
  message: {
    chat_id: REAL_P2P,
    chat_type: 'p2p',
    content: '{"text":"hi"}',
    create_time: '1761091200000',
    message_id: 'om_real_p2p_text',
    message_type: 'text',
    update_time: '1761091200000',
  },
  sender,
})

/** Group, @bot at the start. */
export const REAL_GROUP_AT = cast({
  ...header,
  message: {
    chat_id: REAL_GROUP,
    chat_type: 'group',
    content: '{"text":"@_user_1 测试一下"}',
    create_time: '1761091200000',
    message_id: 'om_real_group_at',
    message_type: 'text',
    mentions: [botMention],
    update_time: '1761091200000',
  },
  sender,
})

/**
 * Group, @bot plus bold text typed in the client's rich editor. It still
 * arrives as message_type text with the formatting dropped, not as post.
 */
export const REAL_GROUP_AT_BOLD = cast({
  ...header,
  message: {
    chat_id: REAL_GROUP,
    chat_type: 'group',
    content: '{"text":"@_user_1 富文本 加粗"}',
    create_time: '1761091200000',
    message_id: 'om_real_group_at_bold',
    message_type: 'text',
    mentions: [botMention],
    update_time: '1761091200000',
  },
  sender,
})

// A group message without @bot was sent too; with only the
// im:message.group_at_msg:readonly scope Feishu never delivers it, so there is
// no event to record.
