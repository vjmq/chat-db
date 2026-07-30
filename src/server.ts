import express from 'express'
import { object, url, string, id, int, optional } from 'cast.ts'
import { print } from 'listening-on'
import { env } from './env'
import { pick } from 'better-sqlite3-proxy'
import { proxy } from './proxy'
import { db } from './db'
import { getName, getTel } from './source/whatsapp/store'
import { Client } from 'whatsapp-web.js'
import { syncMessage } from './source/whatsapp/sync'
import { join as pathJoin } from 'path'

const MEDIA_DIR = pathJoin('res', 'downloads', 'whatsapp')

let app = express()

app.use(express.static('public'))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

function verifyApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  let api_key = req.header('X-API-KEY')
  if (api_key !== env.API_KEY) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}
app.use(verifyApiKey)

let select_chats = db.prepare(/* sql */ `
select
  chat.id
, chat.name
, chat.is_group
, chat.timestamp
, user.tel
from ws_chat as chat
inner join ws_user as user on user.id = chat.user_id
order by timestamp desc
`)

app.get('/chats', (req, res) => {
  try {
    let chats = select_chats.all()
    res.json({ chats })
  } catch (error) {
    res.json({ error: String(error) })
  }
})

type MessageItem = {
  id: number
  type: string
  body: string
  timestamp: number
  from_user_id: number
  from_name?: string
  from_tel?: string
  // not useful for group message
  to_user_id?: number
  to_name?: string
  to_tel?: string
}
let select_messages = db.prepare<
  { chat_id: number; since: number; limit: number },
  MessageItem
>(/* sql */ `
select
  message.id
, message.type
, message.body
, message.timestamp
, ifnull(message.author_user_id, message.from_user_id) as from_user_id
, message.to_user_id
from ws_message as message
where message.chat_id = :chat_id
  and message.id > :since
order by timestamp asc
limit :limit
`)

let count_messages = db
  .prepare(
    /* sql */ `
select count(*)
from ws_message as message
where message.chat_id = :chat_id
`,
  )
  .pluck()

let get_messages_parser = object({
  params: object({
    id: id(),
  }),
  query: object({
    limit: optional(int({ min: 1 })),
    since: optional(id()),
  }),
})
app.get('/chats/whatsapp/:id/messages', (req, res) => {
  try {
    let input = get_messages_parser.parse(req)
    let chat_id = input.params.id
    let chat = proxy.ws_chat[chat_id]
    let is_group = chat.is_group
    let limit = input.query.limit || 20
    let since = input.query.since || 0
    let messages = select_messages.all({ since, limit, chat_id })
    for (let message of messages) {
      let from_name = getName(message.from_user_id)
      if (from_name) {
        message.from_name = from_name
      }
      let from_tel = getTel(message.from_user_id)
      if (from_tel) {
        message.from_tel = from_tel
      }
      if (is_group) {
        delete message.to_user_id
      } else {
        let to_name = getName(message.to_user_id!)
        if (to_name) {
          message.to_name = to_name
        }
        let to_tel = getTel(message.to_user_id!)
        if (to_tel) {
          message.to_tel = to_tel
        }
      }
    }
    let total = count_messages.get({ chat_id }) || 0
    res.json({
      pagination: { total, limit, since },
      messages,
    })
  } catch (error) {
    res.json({ error: String(error) })
  }
})

export let hooks = {
  new_message_url: '',
}
let register_hook_parser = object({
  body: object({
    url: url(),
  }),
})
app.post('/hooks/new-message', (req, res) => {
  try {
    let input = register_hook_parser.parse(req)
    hooks.new_message_url = input.body.url
    res.json({ hooks })
  } catch (error) {
    res.json({ error: String(error) })
  }
})

let select_media = db.prepare<
  { chat_id: number; type: string | null },
  {
    id: number
    filename: string
    content_type: string
    bytes: number | null
    downloaded_at: number | null
    download_error: string | null
    message_id: number
    message_type: string
    timestamp: number
    from_user_id: number
    from_name?: string
    from_tel?: string
  }
>(/* sql */ `
select
  media.id
, media.filename
, media.content_type
, media.bytes
, media.downloaded_at
, media.download_error
, message.id as message_id
, message.type as message_type
, message.timestamp
, ifnull(message.author_user_id, message.from_user_id) as from_user_id
from media
inner join ws_message as message on message.id = media.ws_message_id
where message.chat_id = :chat_id
  and (:type is null or message.type = :type)
order by message.timestamp asc
`)

let list_media_parser = object({
  params: object({ id: id() }),
  query: object({
    type: optional(string()),
  }),
})
app.get('/chats/whatsapp/:id/media', (req, res) => {
  try {
    let input = list_media_parser.parse(req)
    let media = select_media.all({
      chat_id: input.params.id,
      type: input.query.type || null,
    })
    for (let m of media) {
      let from_name = getName(m.from_user_id)
      if (from_name) m.from_name = from_name
      let from_tel = getTel(m.from_user_id)
      if (from_tel) m.from_tel = from_tel
    }
    res.json({ media })
  } catch (error) {
    res.json({ error: String(error) })
  }
})

let select_media_row = db.prepare<
  { id: number },
  { filename: string; content_type: string }
>(/* sql */ `
select filename, content_type
from media
where id = :id
`)

let get_media_parser = object({ params: object({ id: id() }) })
app.get('/media/:id', (req, res) => {
  try {
    let input = get_media_parser.parse(req)
    let row = select_media_row.get({ id: input.params.id })
    if (!row || !row.filename) {
      res.status(404).json({ error: 'media not found' })
      return
    }
    res.setHeader('Content-Type', row.content_type || 'application/octet-stream')
    res.sendFile(pathJoin(MEDIA_DIR, row.filename), { root: process.cwd() })
  } catch (error) {
    res.json({ error: String(error) })
  }
})

let port = env.PORT
app.listen(port, error => {
  if (error) {
    console.error(error)
    process.exit(1)
  }
  print(port)
})

export function attachClient(client: Client) {
  let send_message_parser = object({
    params: object({
      id: id(),
    }),
    body: object({
      content: string(),
    }),
  })
  app.post('/chats/whatsapp/:id/messages', async (req, res) => {
    try {
      let input = send_message_parser.parse(req)
      let chat_id = input.params.id
      let content = input.body.content

      let chat = proxy.ws_chat[chat_id]
      let { user, server } = chat.user!
      let chatId = `${user}@${server}`

      let message = await client.sendMessage(chatId, content, {})
      let message_id = syncMessage(message, chat_id)
      res.json({ message_id })
    } catch (error) {
      res.json({ error: String(error) })
    }
  })
}
