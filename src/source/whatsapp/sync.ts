import { Client, Chat as WChat, Message as WMessage } from 'whatsapp-web.js'
import { count, find, pick, seedRow, update } from 'better-sqlite3-proxy'
import { WsChat, proxy } from '../../proxy'
import { db } from '../../db'
import { env } from '../../env'
import { formatProgress } from '../../format'
import { GroupMetadata, MessageData } from '../../types'
import { ProgressCli } from '@beenotung/tslib/progress-cli'
import { sleep } from '@beenotung/tslib/async/wait'
import { writeFileSync, log } from './utils'
import { mkdirSync, writeFileSync as fsWriteFile } from 'fs'
import { extname, join } from 'path'

let select_user_without_tel = db.prepare<
  void[],
  { id: number; server: string; user: string }
>(/* sql */ `
select id, server, user
from ws_user as user
where tel is null
  and user != '0'
  and (server = 'lid' or server = 'c.us')
`)

export async function sync(client: Client) {
  let cli = new ProgressCli()

  let chats = await getChatsWithRetry(client)
  if (chats.length === 0) {
    log.error('no chats returned from WhatsApp web after retries')
  }
  chats = applyChatLimit(chats)
  // writeFileSync('chats.json', chats))
  let pairs = []
  let chat_index = 0
  for (let chat of chats) {
    chat_index++
    cli.update(
      '[sync] saving chats... ' + formatProgress(chat_index, chats.length),
    )
    let chat_row = syncChat(chat)
    pairs.push({ chat, chat_row })
  }
  cli.nextLine()

  chat_index = 0
  for (let { chat, chat_row } of pairs) {
    chat_index++
    let chat_id = chat_row.id!
    cli.update(`[sync] loading chat ${chat_index}/${chats.length} messages... `)
    cli.update(
      `[sync] loading chat ${chat_index}/${chats.length} messages... [open chat window]`,
    )
    await retry(() => client.interface.openChatWindow(chat.id._serialized))
    // await client.interface.openChatWindow(chat.id._serialized)
    await sleep(2000)
    cli.update(
      `[sync] loading chat ${chat_index}/${chats.length} messages... [sync history]`,
    )
    await client.syncHistory(chat.id._serialized)
    await sleep(1000)
    cli.update(
      `[sync] loading chat ${chat_index}/${chats.length} messages... [fetch messages]`,
    )
    let messages = await fetchMessages({
      chat,
      initial_limit: count(proxy.ws_message, { chat_id }),
      onProgress: count => {
        cli.update(
          `[sync] loading chat ${chat_index}/${chats.length} messages... [fetch messages] (${count} messages loaded)`,
        )
      },
    })
    // writeFileSync(`messages_${chat.id._serialized}.json`, messages)
    let message_index = 0
    for (let message of messages) {
      message_index++
      cli.update(
        `[sync] saving chat ${chat_index}/${chats.length} messages... ` +
          formatProgress(message_index, messages.length),
      )
      syncMessageWithMedia(message, chat_id)
    }
    if (messages.length === 0) {
      cli.update(
        `[sync] saving chat ${chat_index}/${chats.length} messages... (0/0)`,
      )
    }
  }
  cli.nextLine()

  let users = select_user_without_tel.all()
  let user_index = 0
  for (let user of users) {
    user_index++
    cli.update(
      `[sync] loading users... ${formatProgress(user_index, users.length)}`,
    )
    let tel = ''
    let result = await client.getContactLidAndPhone([
      user.user + '@' + user.server,
    ])
    let pn = result[0]?.pn
    if (pn) {
      tel = await client.getFormattedNumber(pn)
    }
    tel ||= ''
    update(proxy.ws_user, { id: user.id }, { tel })
  }
  cli.nextLine()
}

async function retry(fn: () => Promise<void>) {
  for (;;) {
    try {
      await fn()
      break
    } catch (error) {
      let message = String(error)
      if (message.includes('Promise was collected')) {
        await sleep(1000)
        continue
      }
      throw error
    }
  }
}

async function retryReturn<T>(fn: () => Promise<T>): Promise<T> {
  let max_attempts = 90
  let last_error: any = null
  let last_was_empty = false
  for (let attempt = 0; attempt < max_attempts; attempt++) {
    try {
      let result = await fn()
      let is_empty = !!(result && (result as any).length === 0)
      if (is_empty) {
        last_was_empty = true
        if (attempt < max_attempts - 1) {
          if (attempt % 10 === 0) {
            log.app(
              `getChats still empty after ${attempt}s, waiting for chat list to hydrate...`,
            )
          }
          await sleep(1000)
          continue
        }
      }
      return result
    } catch (error) {
      last_error = error
      last_was_empty = false
      if (attempt < max_attempts - 1) {
        await sleep(1000)
        continue
      }
    }
  }
  if (last_was_empty) {
    throw new Error(
      'retryReturn: exhausted retries (last call returned empty array)',
    )
  }
  throw last_error ?? new Error('retryReturn: exhausted retries')
}

async function getChatsWithRetry(client: Client) {
  await sleep(2000)
  try {
    return await retryReturn(() => client.getChats() as Promise<WChat[]>)
  } catch (error) {
    let state = await safeGetState(client)
    log.error(
      'getChats failed after retries; page state =',
      state,
      'error =',
      String(error),
    )
    throw error
  }
}

async function safeGetState(client: Client): Promise<string> {
  try {
    let state = await client.getState()
    return String(state)
  } catch {
    return 'unknown (evaluate failed)'
  }
}

function applyChatLimit(chats: WChat[]): WChat[] {
  let chat_limit = Number(env.WS_CHAT_LIMIT)
  if (!Number.isFinite(chat_limit) || chat_limit <= 0) return chats
  let limit = Math.floor(chat_limit)
  if (limit >= chats.length) return chats
  let scored = chats.map(chat => {
    let user_id = getUserId(chat.id)
    let chat_row = find(proxy.ws_chat, { user_id })
    let existing = chat_row?.id
      ? count(proxy.ws_message, { chat_id: chat_row.id! })
      : 0
    return { chat, existing }
  })
  scored.sort((a, b) => a.existing - b.existing)
  let picked = scored.slice(0, limit)
  log.app(
    `WS_CHAT_LIMIT active: syncing ${picked.length}/${chats.length} chats (skipped ${chats.length - picked.length}, prioritized by least-synced)`,
  )
  return picked.map(p => p.chat)
}

async function fetchMessages(args: {
  chat: WChat
  onProgress: (count: number) => void
  initial_limit: number
}) {
  let limit = args.initial_limit || 100
  let prev_count = 0
  let interval = 500
  while (true) {
    await sleep(interval)
    let messages = await args.chat.fetchMessages({ limit })
    let message_limit = Number(env.WS_MESSAGE_LIMIT)
    if (
      Number.isFinite(message_limit) &&
      message_limit > 0 &&
      messages.length > message_limit
    ) {
      messages = messages.slice(0, Math.floor(message_limit))
    }
    args.onProgress(messages.length)
    if (messages.length != prev_count) {
      prev_count = messages.length
      limit *= 2
      interval = 500
      continue
    }
    if (interval < 1500) {
      interval += 500
      continue
    }
    return messages
  }
}

function parseUser(remote: string) {
  let [user, server] = remote
    .split('_')
    .find(part => part.includes('@'))!
    .split('@')
  return { server, user }
}

function getUserId(args: { server: string; user: string }): number {
  return seedRow(proxy.ws_user, {
    server: args.server,
    user: args.user,
  })
}

export let syncChat = (chat: WChat & { groupMetadata?: GroupMetadata }) => {
  let user_id = getUserId(chat.id)
  let chat_row = find(proxy.ws_chat, { user_id })
  let updates: Omit<WsChat, 'id' | 'user_id' | 'last_message_id'> = {
    name: chat.name,
    is_group: chat.isGroup,
    is_read_only: chat.isReadOnly,
    unread_count: chat.unreadCount,
    timestamp: chat.timestamp,
    archived: chat.archived,
    pinned: chat.pinned,
    is_muted: chat.isMuted,
    mute_expiration: chat.muteExpiration,
  }
  if (!chat_row) {
    let id = proxy.ws_chat.push({
      user_id,
      ...updates,
      last_message_id: null,
    })
    chat_row = proxy.ws_chat[id]
  } else {
    Object.assign(chat_row, updates)
  }
  let groupMetadata = chat.groupMetadata
  if (groupMetadata) {
    seedRow(
      proxy.ws_group,
      { group_user_id: user_id },
      {
        creation_time: groupMetadata.creation,
        owner_user_id: getUserId(groupMetadata.owner),
        subject: groupMetadata.subject,
        subject_time: groupMetadata.subjectTime,
        desc: groupMetadata.desc || null,
        desc_id: groupMetadata.descId || null,
        desc_time: groupMetadata.descTime || null,
        desc_owner_user_id: groupMetadata.descOwner
          ? getUserId(groupMetadata.descOwner)
          : null,
        membership_approval_mode: groupMetadata.membershipApprovalMode,
        member_add_mode: groupMetadata.memberAddMode,
        suspended: groupMetadata.suspended,
        terminated: groupMetadata.terminated,
        is_parent_group: groupMetadata.isParentGroup,
        is_parent_group_closed: groupMetadata.isParentGroupClosed,
        parent_group_id: groupMetadata.parentGroup
          ? getUserId(groupMetadata.parentGroup)
          : null,
        pending_participants:
          groupMetadata.pendingParticipants.length > 0
            ? JSON.stringify(groupMetadata.pendingParticipants)
            : null,
        past_participants:
          groupMetadata.pastParticipants.length > 0
            ? JSON.stringify(groupMetadata.pastParticipants)
            : null,
      },
    )
  }
  return chat_row
}
syncChat = db.transaction(syncChat)

export function getChatId(message: WMessage): number {
  let [user, server] = message.id.remote.split('@')
  let user_row = find(proxy.ws_user, { server, user })
  if (!user_row) {
    throw new Error(`user ${message.id.remote} not found`)
  }
  let chat_row = find(proxy.ws_chat, { user_id: user_row.id! })
  if (!chat_row) {
    throw new Error(`chat for user ${message.id.remote} not found`)
  }
  return chat_row.id!
}

export let syncMessage = (
  message: WMessage & { _data?: MessageData },
  chat_id = getChatId(message),
): number => {
  let data = message._data!
  // writeFileSync('message.json', message)
  let message_id = seedRow(
    proxy.ws_message,
    { api_id: message.id.id },
    {
      chat_id,
      media_id: null,
      ack: message.ack,
      has_media: message.hasMedia,
      body: message.body,
      type: message.type,
      timestamp: message.timestamp,
      from_user_id: getUserId(parseUser(message.from)),
      to_user_id: message.to ? getUserId(parseUser(message.to)) : null,
      author_user_id: message.author
        ? getUserId(parseUser(message.author))
        : null,
      device_type: message.deviceType,
      is_forwarded: message.isForwarded,
      forwarding_score: message.forwardingScore,
      is_status: message.isStatus,
      is_starred: message.isStarred,
      from_me: message.fromMe,
      has_quoted_message: message.hasQuotedMsg,
      has_reaction: message.hasReaction,
      vcards:
        message.vCards?.length > 0 ? JSON.stringify(message.vCards) : null,
      mentioned_ids:
        message.mentionedIds?.length > 0
          ? JSON.stringify(message.mentionedIds)
          : null,
      group_mentions:
        message.groupMentions?.length > 0
          ? JSON.stringify(message.groupMentions)
          : null,
      is_gif: message.isGif,
      links: message.links?.length > 0 ? JSON.stringify(message.links) : null,
      poll_options:
        message.pollOptions?.length > 0
          ? JSON.stringify(message.pollOptions)
          : null,
      poll_votes:
        data.pollVotesSnapshot?.pollVotes?.length > 0
          ? JSON.stringify(data.pollVotesSnapshot.pollVotes)
          : null,
    },
  )
  return message_id
}
syncMessage = db.transaction(syncMessage)

export async function syncMessageWithMedia(
  message: WMessage & { _data?: MessageData },
  chat_id = getChatId(message),
): Promise<number> {
  let message_id = syncMessage(message, chat_id)
  if (message.hasMedia) {
    let media_id = await downloadMessageMedia({
      ws_message_id: message_id,
      api_id: message.id.id,
      message,
    })
    if (media_id != null) {
      update(proxy.ws_message, { id: message_id }, { media_id })
    }
  }
  return message_id
}

const DOWNLOAD_DIR = join('res', 'downloads', 'whatsapp')

function mimeExt(mime: string): string {
  if (mime.startsWith('audio/')) return `.${mime.split('/')[1].split(';')[0]}`
  if (mime.startsWith('image/')) return `.${mime.split('/')[1]}`
  if (mime.startsWith('video/')) return `.${mime.split('/')[1]}`
  return '.bin'
}

export async function downloadMessageMedia(args: {
  ws_message_id: number
  api_id: string
  message: WMessage
}): Promise<number | null> {
  let message = args.message
  if (!message.hasMedia) return null
  let filename = ''
  let content_type = ''
  let bytes = 0
  let download_error: string | null = null
  try {
    let media = await message.downloadMedia()
    content_type = media.mimetype
    let has_ext = media.filename && extname(media.filename)
    filename = has_ext
      ? media.filename!
      : `${args.api_id}${mimeExt(media.mimetype)}`
    mkdirSync(DOWNLOAD_DIR, { recursive: true })
    let buf = Buffer.from(media.data, 'base64')
    bytes = buf.length
    fsWriteFile(join(DOWNLOAD_DIR, filename), buf)
  } catch (e) {
    download_error = String(e)
  }
  return seedRow(
    proxy.media,
    { ws_message_id: args.ws_message_id },
    {
      source: 'whatsapp',
      filename,
      content_type,
      bytes,
      downloaded_at: download_error ? null : Date.now(),
      download_error,
    },
  )
}
