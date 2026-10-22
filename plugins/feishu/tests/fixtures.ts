/**
 * Hand-written im.message.receive_v1 fixtures, shaped after the
 * @larksuiteoapi/node-sdk IHandles typing.
 *
 * Real captured events live in real-events.ts; these cover the cases those
 * don't (strangers, approvers, @all, post, reply-to-bot).
 */

import type { FeishuMention, FeishuMessageEvent } from '../lib.ts'

export const BOT = 'ou_bot000000000000000000000000000'
export const ALICE = 'ou_alice00000000000000000000000000' // allowFrom
export const BOB = 'ou_bob0000000000000000000000000000' // approver
export const EVE = 'ou_eve0000000000000000000000000000' // stranger
export const GROUP = 'oc_group0000000000000000000000000'
export const P2P_ALICE = 'oc_p2palice000000000000000000000'
export const P2P_BOB = 'oc_p2pbob00000000000000000000000'
export const P2P_EVE = 'oc_p2peve00000000000000000000000'

let seq = 0

export function botMention(key = '@_user_1'): FeishuMention {
  return { key, id: { open_id: BOT }, name: 'Claude', mentioned_type: 'bot' }
}

export function userMention(key: string, openId: string, name: string): FeishuMention {
  return { key, id: { open_id: openId }, name, mentioned_type: 'user' }
}

export const ALL_MENTION: FeishuMention = { key: '@_all', id: {}, name: '所有人' }

export function event(opts: {
  sender: string
  chatId: string
  chatType?: string
  text?: string
  messageType?: string
  content?: string
  mentions?: FeishuMention[]
  parentId?: string
  senderType?: string
}): FeishuMessageEvent {
  const messageType = opts.messageType ?? 'text'
  return {
    sender: {
      sender_id: { open_id: opts.sender },
      sender_type: opts.senderType ?? 'user',
    },
    message: {
      message_id: `om_${++seq}`,
      chat_id: opts.chatId,
      chat_type: opts.chatType ?? (opts.chatId.startsWith('oc_p2p') ? 'p2p' : 'group'),
      message_type: messageType,
      content: opts.content ?? JSON.stringify({ text: opts.text ?? '' }),
      create_time: '1761091200000',
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
      ...(opts.parentId ? { parent_id: opts.parentId } : {}),
    },
  }
}
