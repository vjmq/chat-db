import { find, seedRow } from 'better-sqlite3-proxy'
import { proxy } from '../../proxy'
import { db } from '../../db'
import { EmailAccountConfig } from './adapter'
import { log } from './utils'

export type EmailMessage = {
  api_id: string
  thread_key: string
  from_address: string
  from_display_name?: string | null
  to_address?: string | null
  to_display_name?: string | null
  body: string
  timestamp: number
  from_me: boolean
  message_id_header?: string | null
  in_reply_to?: string | null
  references?: string | null
  subject?: string | null
}

let select_account = db.prepare<{ id: string }, { id: string; provider: string; address: string; session_dir: string; last_synced_at: number | null }>(
  /* sql */ `
select id, provider, address, session_dir, last_synced_at
from em_account
where id = :id
`,
)

let insert_account = db.prepare(
  /* sql */ `
insert into em_account (id, provider, address, session_dir, last_synced_at)
values (:id, :provider, :address, :session_dir, null)
on conflict(id) do nothing
`,
)

let touch_account = db.prepare(
  /* sql */ `
update em_account
set last_synced_at = :last_synced_at
where id = :id
`,
)

let insert_message = db.prepare(
  /* sql */ `
insert into em_message (
  account_id, chat_id, api_id, timestamp,
  from_user_id, to_user_id, body, from_me,
  message_id_header, in_reply_to, references
)
values (
  :account_id, :chat_id, :api_id, :timestamp,
  :from_user_id, :to_user_id, :body, :from_me,
  :message_id_header, :in_reply_to, :references
)
on conflict(account_id, api_id) do update set
  chat_id = excluded.chat_id,
  timestamp = excluded.timestamp,
  from_user_id = excluded.from_user_id,
  to_user_id = excluded.to_user_id,
  body = excluded.body,
  from_me = excluded.from_me,
  message_id_header = excluded.message_id_header,
  in_reply_to = excluded.in_reply_to,
  references = excluded.references
`,
)

export function getUserId(address: string, display_name?: string | null) {
  let row = find(proxy.em_user, { address })
  if (row) return row.id!
  let name = display_name || address.split('@')[0]
  return seedRow(proxy.em_user, { address }, { display_name: name })
}

export function getChatId(account_id: string, thread_key: string) {
  let row = find(proxy.em_chat, { account_id, thread_key })
  if (row) return row.id!
  return seedRow(
    proxy.em_chat,
    { account_id, thread_key },
    { normalized_subject: thread_key, last_message_id: null },
  )
}

export function syncAccount(account: EmailAccountConfig) {
  let row = select_account.get({ id: account.id })
  if (row) return row
  insert_account.run({
    id: account.id,
    provider: account.provider,
    address: account.address,
    session_dir: account.id,
  })
  return select_account.get({ id: account.id })!
}

export let syncMessage = (
  account: EmailAccountConfig,
  message: EmailMessage,
): number => {
  syncAccount(account)
  let account_id = account.id
  let from_user_id = getUserId(
    message.from_address,
    message.from_display_name,
  )
  let to_user_id = message.to_address
    ? getUserId(message.to_address, message.to_display_name)
    : null
  let chat_id = getChatId(account_id, message.thread_key)
  let fields = {
    account_id,
    chat_id,
    api_id: message.api_id,
    timestamp: message.timestamp,
    from_user_id,
    to_user_id,
    body: message.body,
    from_me: message.from_me,
    message_id_header: message.message_id_header || null,
    in_reply_to: message.in_reply_to || null,
    references: message.references || null,
  }
  insert_message.run(fields)
  let row = find(proxy.em_message, { account_id, api_id: message.api_id })
  let id = row?.id ?? 0
  let chat_row = proxy.em_chat[chat_id]
  if (chat_row && !chat_row.last_message_id) {
    chat_row.last_message_id = id
  }
  return id
}
syncMessage = db.transaction(syncMessage)

export async function sync(
  account: EmailAccountConfig,
  fetch_messages: () => Promise<EmailMessage[]>,
) {
  syncAccount(account)
  let messages = await fetch_messages()
  log.client('sync', account.id, 'messages', messages.length)
  for (let message of messages) {
    syncMessage(account, message)
  }
  touch_account.run({ id: account.id, last_synced_at: Date.now() })
}
