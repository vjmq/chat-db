# Email API Implementation

## Overview

Add a new `email` source to the `chat-db` codebase that ingests emails (and replies) sent to a designated address into the same SQLite database, using the same architecture as the existing `whatsapp` and `telegram` integrations.

---

## Goals

- Read emails sent **to** a designated mailbox (e.g. `chat+<id>@example.com`).
- Track **threads** (the email subject acts as the chat; each message is an email in the thread).
- Track **replies** to existing threads as messages in the same chat.
- Read **all participants** (sender + recipients) and store them as users.
- Persist attachments to disk and reference them from a `media` table (mirrors the `tasks/whatsapp.md` plan).
- Stay consistent with the existing `ws_*` / `tg_*` naming convention by introducing an `em_*` (email) namespace.
- Expose the synced data through the same HTTP API in [src/server.ts](src/server.ts) once the `server.md` multi-source view is in place.

---

## High-Level Architecture

```
migrations/  ──► Knex + auto-migrate ──► erd.txt ──► src/proxy.ts
                                                     │
src/server.ts  ◄── HTTP API (Express) ◄── /chats, /messages
       │
       ├── src/source/whatsapp/   ──► whatsapp-web.js
       ├── src/source/telegram/   ──► teleproto (TDLib)
       └── src/source/email/      ──► gmail-api / imap-flow (NEW)
                    │
                    └──► src/db.ts (better-sqlite3) ──► db.sqlite3
```

The new source lives in `src/source/email/` and follows the exact 4-file layout used by WhatsApp and Telegram:

| File | Role |
|---|---|
| `adapter.ts` | Construct the email client, expose `client`, `ready`, `events`, `getAuthState`, `getIdentity()` |
| `cli.ts` | Entry point invoked from `src/cli.ts`; wires events, runs initial `sync()` |
| `sync.ts` | Pull historical messages, upsert users / chats / messages into DB |
| `utils.ts` | `makeSourceUtils({ source: 'email' })` — provides `log` and `writeFileSync` |

---

## Pre-requisites

- [ ] Decide on a mail provider and auth model. Recommended: **Gmail API** (OAuth2, rich metadata, no IMAP parsing) or **IMAP + SMTP** (works with any provider, including self-hosted / Outlook / Fastmail).
- [ ] Acquire credentials:
  - **Gmail API**: create a Google Cloud project, enable Gmail API, download OAuth2 client (`credentials.json`), complete one-time OAuth flow to obtain a `token.json` (refresh + access tokens).
  - **IMAP/SMTP**: app password (Gmail) or standard credentials; gather IMAP host, IMAP port, SMTP host, SMTP port.
- [ ] Pick a designated mailbox address. For Gmail, a single mailbox is queried; per-thread routing can be done by `To:` containing `chat+<thread-token>@example.com` (Gmail ignores the `+…` suffix and the address still arrives in the inbox).

### Library Choices

| Library | Use case |
|---|---|
| `googleapis` | Official Gmail API client (recommended) |
| `imapflow` | Modern IMAP client (Node 18+, ESM-friendly, streaming) |
| `nodemailer` | Send replies / outbound mail via SMTP |
| `mailparser` | Parse RFC822 / MIME messages into structured objects (used in tandem with `imapflow`) |
| `@types/nodemailer`, `@types/mailparser` | Type definitions |

---

## Step-by-Step Implementation

### Step 1 — Add environment variables

Edit [src/env.ts](src/env.ts) to declare the new configuration:

```ts
export let env = {
  // ...existing keys...

  // Email source
  EMAIL_PROVIDER: 'gmail' as 'gmail' | 'imap', // or omit and pick based on presence of credentials
  EMAIL_SESSION_DIR: '.email_auth',
  EMAIL_ADDRESS: '',
  GMAIL_CLIENT_ID: '',
  GMAIL_CLIENT_SECRET: '',
  GMAIL_REDIRECT_URI: 'http://localhost:3000/oauth2callback',
  GMAIL_TOKEN_PATH: '.email_auth/token.json',
  // IMAP fallback
  EMAIL_IMAP_HOST: '',
  EMAIL_IMAP_PORT: 993,
  EMAIL_IMAP_USER: '',
  EMAIL_IMAP_PASSWORD: '',
  EMAIL_SMTP_HOST: '',
  EMAIL_SMTP_PORT: 465,
}
```

Update `.env` (or `.env.example`) and populate values locally. Never commit secrets.

### Step 2 — Define schema in `erd.txt`

Append a new `em_*` block to [erd.txt](erd.txt), mirroring the `ws_*` shape. The conventions are:

- `*_user` — a contact. For email, the natural key is the email address.
- `*_chat` — a conversation. For email, the natural key is the normalized subject (Re: / Fwd: stripped) — i.e. the "thread".
- `*_message` — a single message. For email, each inbound or outbound email.
- `*_group` / `*_group_participants` — not applicable to email; skip these.

Add to [erd.txt](erd.txt):

```
em_user
-------
id integer PK
address text unique   -- email address (lowercased)
name text NULL         -- display name parsed from "From:" header


em_chat
-------
id integer PK
user_id integer unique FK >0- em_user.id
-- The user here is the "self" mailbox identity. The other participants live on each message.
subject text            -- normalized subject (Re:/Fwd: stripped)
is_group boolean        -- true when more than one distinct "From:" appears in the thread
is_read_only boolean    -- always false for inbound mail we own
unread_count integer
timestamp integer NULL  -- ms epoch of the most recent message
archived boolean NULL
pinned boolean
is_muted boolean
mute_expiration integer
last_message_id integer NULL
thread_key text unique  -- lowercase subject with whitespace collapsed, used for reply grouping


em_message
----------
id integer PK
chat_id integer FK >0- em_chat.id
api_id text unique      -- Gmail messageId or IMAP UID
ack integer NULL        -- 0=unread, 1=read (mirrors WhatsApp ack)
has_media boolean
body text               -- plaintext body (fall back to html->text if absent)
type text               -- 'inbox' | 'sent' | 'draft'
timestamp integer       -- ms epoch
from_user_id integer FK >0- em_user.id
to_user_id integer NULL FK >0- em_user.id
author_user_id integer NULL FK >0- em_user.id  -- alias of from_user_id for joins
device_type text        -- provider name: 'gmail' | 'imap'
is_forwarded boolean NULL
forwarding_score integer
is_status boolean       -- false for email
is_starred boolean
from_me boolean         -- true when this mailbox is the sender
has_quoted_message boolean
has_reaction boolean
vcards json NULL        -- not used
mentioned_ids json NULL -- email addresses in To/Cc (other than the self address)
group_mentions json NULL
is_gif boolean
links json NULL         -- URLs extracted from body
poll_options json NULL
poll_votes json NULL
message_id_header text  -- RFC822 Message-ID header for reply pairing
in_reply_to text NULL   -- RFC822 In-Reply-To header
references text NULL    -- RFC822 References header
```

#### Optional: shared `media` table

The [tasks/whatsapp.md](tasks/whatsapp.md) task already proposes a `media` table. Reuse it for email attachments:

```
media
-----
id integer PK
source enum(whatsapp, telegram, email)
ws_user_id integer NULL FK >0- ws_user.id
tg_user_id integer NULL FK >0- tg_user.id
em_user_id integer NULL FK >0- em_user.id
filename text
content_type text
```

If that table is not yet in `erd.txt`, add it now (it serves all three sources).

### Step 3 — Generate schema + typed proxy

```bash
npm run db:dev
```

This runs (in order):
1. `db:plan` — `auto-migrate db.sqlite3 < erd.txt` (preview the diff).
2. `db:migrate` — `knex migrate:latest` (apply).
3. `db:gen-proxy` — `erd-to-proxy < erd.txt > src/proxy.ts` (regenerate typed DB proxy).

Verify that:
- A new migration was created under [migrations/](migrations/) for the `em_*` tables.
- [src/proxy.ts](src/proxy.ts) now contains `em_user`, `em_chat`, `em_message` exports.
- Tables exist in `db.sqlite3` (inspect with `sqlite3 db.sqlite3 ".tables"`).

### Step 4 — Implement `src/source/email/utils.ts`

Trivial, identical to the other sources:

```ts
// filepath: src/source/email/utils.ts
import { makeSourceUtils } from '../../utils'

export let { writeFileSync, log } = makeSourceUtils({ source: 'email' })
```

This gives us `log.client`, `log.app`, `log.error`, `log.debug` and a `res/email/` directory for diagnostic dumps.

### Step 5 — Implement `src/source/email/adapter.ts`

Mirror the structure in [src/source/whatsapp/adapter.ts](src/source/whatsapp/adapter.ts) and [src/source/telegram/adapter.ts](src/source/telegram/adapter.ts).

Required exports:
- `client` — the underlying SDK instance (Gmail API client, or `imapflow` connection).
- `ready` — `Promise<void>` that resolves when authenticated and the inbox is reachable.
- `events` — `EventEmitter<ClientEventMap>` emitting `ready`, `qr`, `disconnected`, `authenticated`, `auth_failure`.
- `getAuthState()` — `'loading' | 'authenticated' | 'not_authenticated'`.
- `getIdentity()` — returns the mailbox address as a string (analogous to `getTel()` for chat platforms).

**Gmail variant sketch:**

```ts
// filepath: src/source/email/adapter.ts
import { google } from 'googleapis'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { ClientEventMap, AuthState } from '../../utils'
import { env } from '../../env'
import { log } from './utils'

export function getClient(options: { session_dir: string }) {
  let events = new EventEmitter<ClientEventMap>()
  let authState: AuthState = 'loading'
  let ready = new Promise<void>(async (resolve, reject) => {
    try {
      let oauth2 = new google.auth.OAuth2(
        env.GMAIL_CLIENT_ID,
        env.GMAIL_CLIENT_SECRET,
        env.GMAIL_REDIRECT_URI,
      )
      let tokenPath = join(options.session_dir, 'token.json')
      if (existsSync(tokenPath)) {
        oauth2.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf8')))
      } else {
        // One-time interactive flow:
        let url = oauth2.generateAuthUrl({
          access_type: 'offline',
          scope: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send',
          ],
        })
        log.app('Authorize here:', url)
        // Capture the code from a local callback server or stdin, then:
        // let { tokens } = await oauth2.getToken(code)
        // oauth2.setCredentials(tokens)
        // await fs.writeFile(tokenPath, JSON.stringify(tokens))
        authState = 'not_authenticated'
        events.emit('auth_failure', 'no token; complete OAuth first')
        return reject(new Error('No Gmail token; complete OAuth once'))
      }
      let gmail = google.gmail({ version: 'v1', auth: oauth2 })
      // Verify token
      await gmail.users.getProfile({ userId: 'me' })
      authState = 'authenticated'
      events.emit('ready')
      resolve()
    } catch (error) {
      authState = 'not_authenticated'
      events.emit('auth_failure', error as string)
      reject(error)
    }
  })

  function getIdentity() {
    return env.EMAIL_ADDRESS
  }
  function getAuthState() {
    return authState
  }

  return { client: google.gmail({ version: 'v1' }), ready, events, getIdentity, getAuthState }
}
```

(Concrete token-persistence + refresh logic follows the standard `googleapis` OAuth2 pattern; auto-refresh is handled by `oauth2.on('tokens', …)`.)

**IMAP variant sketch:**

For the IMAP provider, replace the OAuth2 logic with `imapflow`:

```ts
import { ImapFlow } from 'imapflow'

let client = new ImapFlow({
  host: env.EMAIL_IMAP_HOST,
  port: env.EMAIL_IMAP_PORT,
  secure: true,
  auth: { user: env.EMAIL_IMAP_USER, pass: env.EMAIL_IMAP_PASSWORD },
  logger: false,
})
await client.connect()
authState = 'authenticated'
events.emit('ready')
```

Either way, the function must:
- Block `ready` until authentication is confirmed.
- Emit `ready` exactly once.
- Be idempotent on restart (the session dir is the source of truth).

### Step 6 — Implement `src/source/email/sync.ts`

Mirror [src/source/whatsapp/sync.ts](src/source/whatsapp/sync.ts) and [src/source/telegram/sync.ts](src/source/telegram/sync.ts). The flow:

1. **List threads / mailboxes** (Gmail: `users.threads.list`; IMAP: open `INBOX`).
2. For each thread, fetch all messages (paginated).
3. For each message, upsert:
   - `em_user` rows for every `From` / `To` / `Cc` address.
   - The `em_chat` row for the thread (one per normalized subject).
   - The `em_message` row, with `from_user_id`, `to_user_id`, body, headers, flags.

#### Helpers

- `getUserId(address)`: `seedRow(proxy.em_user, { address: address.toLowerCase() })`.
- `getChatId(message)`: derive a `thread_key` from the normalized subject (`Re:`, `Fwd:`, `RE:`, `FW:` stripped, whitespace collapsed) and `seedRow(proxy.em_chat, { thread_key }, { user_id: selfId, ... })`.
- `syncMessage(msg, chatId)`: insert/update one `em_message` row, set `last_message_id` on the parent chat.
- `replyPairing`: when an incoming message has an `In-Reply-To` header, look up the parent `em_message` by `message_id_header` and ensure it lives in the same `em_chat` (or merge two chats if the subject drifted).

#### Initial sync vs. ongoing

- `sync(client)` — historical backfill (like WhatsApp and Telegram).
- For real-time delivery, Gmail offers **Gmail Push Notifications via Cloud Pub/Sub** (recommended) or `users.watch`. IMAP offers `IDLE` (recommended) or polling. Wire whichever to the same `client.on('message', …)` callback used by chat platforms so that the same `syncMessage()` code path runs.

```ts
// filepath: src/source/email/sync.ts
import { count, find, pick, seedRow, update } from 'better-sqlite3-proxy'
import { proxy } from '../../proxy'
import { db } from '../../db'
import { formatProgress } from '../../format'
import { ProgressCli } from '@beenotung/tslib/progress-cli'
import { sleep } from '@beenotung/tslib/async/wait'
import { log, writeFileSync } from './utils'

export async function sync(client /* Gmail | ImapFlow */) {
  let cli = new ProgressCli()
  let messages = await fetchAllMessages(client)
  let index = 0
  for (let message of messages) {
    index++
    cli.update('[email sync] saving... ' + formatProgress(index, messages.length))
    syncMessage(message)
  }
  cli.nextLine()
}

export function getChatId(message: ParsedEmail): number {
  let thread_key = normalizeSubject(message.subject)
  return seedRow(
    proxy.em_chat,
    { thread_key },
    {
      user_id: getUserId(env.EMAIL_ADDRESS),
      subject: message.subject,
      is_group: message.participantCount > 2,
      is_read_only: false,
      unread_count: 0,
      timestamp: message.date.getTime(),
      archived: false,
      pinned: false,
      is_muted: false,
      mute_expiration: 0,
      last_message_id: null,
    },
  ).id!
}

export function syncMessage(message: ParsedEmail): number {
  let chat_id = getChatId(message)
  let from_id = getUserId(message.from.address)
  let to_id = message.to[0] ? getUserId(message.to[0].address) : null
  let api_id = message.providerId // Gmail messageId or IMAP UID
  let id = seedRow(
    proxy.em_message,
    { api_id },
    {
      chat_id,
      ack: message.unread ? 0 : 1,
      has_media: message.attachments.length > 0,
      body: message.text,
      type: message.from.address.toLowerCase() === env.EMAIL_ADDRESS.toLowerCase() ? 'sent' : 'inbox',
      timestamp: message.date.getTime(),
      from_user_id: from_id,
      to_user_id: to_id,
      author_user_id: from_id,
      device_type: 'gmail', // or 'imap'
      is_forwarded: false,
      forwarding_score: 0,
      is_status: false,
      is_starred: !!message.labelIds?.includes('STARRED'),
      from_me: message.from.address.toLowerCase() === env.EMAIL_ADDRESS.toLowerCase(),
      has_quoted_message: !!message.inReplyTo,
      has_reaction: false,
      vcards: null,
      mentioned_ids: JSON.stringify(
        message.to.concat(message.cc || []).map(a => a.address.toLowerCase()),
      ),
      group_mentions: null,
      is_gif: false,
      links: JSON.stringify(extractLinks(message.text || message.html || '')),
      poll_options: null,
      poll_votes: null,
      message_id_header: message.messageId,
      in_reply_to: message.inReplyTo || null,
      references: (message.references || []).join(' ') || null,
    },
  )
  // Update chat last_message_id and timestamp
  update(proxy.em_chat, { id: chat_id }, {
    timestamp: message.date.getTime(),
    last_message_id: id,
  })
  return id
}

function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function getUserId(address: string): number {
  return seedRow(proxy.em_user, {
    address: address.toLowerCase(),
  })
}
```

Wrap top-level mutations in `db.transaction(...)` (as Telegram does for `syncDialog`) so a crash mid-sync does not leave partial state.

### Step 7 — Implement `src/source/email/cli.ts`

Mirror [src/source/whatsapp/cli.ts](src/source/whatsapp/cli.ts) exactly:

```ts
// filepath: src/source/email/cli.ts
import { env } from '../../env'
import { attachClient } from '../../server'   // optional; add a no-op or new attachEmail() helper
import { getClient } from './adapter'
import { sync, syncMessage } from './sync'
import { log } from './utils'

export async function main() {
  let adapter = getClient({ session_dir: env.EMAIL_SESSION_DIR })
  adapter.events.on('ready', () => log.client('ready'))
  adapter.events.on('qr', () => log.client('qr (n/a for email)'))
  adapter.events.on('disconnected', (r) => log.client('disconnected', r))
  adapter.events.on('authenticated', () => log.client('authenticated'))
  adapter.events.on('auth_failure', (m) => log.client('auth_failure', m))
  await adapter.ready
  log.app('client identity:', adapter.getIdentity() || 'unknown')
  log.app('auth state:', adapter.getAuthState())

  // Real-time listener (Gmail Pub/Sub webhook or IMAP IDLE)
  adapter.client.on?.('message', (msg) => {
    try { syncMessage(parseIncoming(msg)) } catch (e) { log.error('sync msg failed', e) }
  })

  log.app('syncing messages...')
  await sync(adapter.client)
  log.app('synced messages')
}
```

### Step 8 — Wire into the main entry point

Update [src/cli.ts](src/cli.ts) to call the new source alongside WhatsApp and Telegram:

```ts
import './server'
import * as whatsapp_cli from './source/whatsapp/cli'
import * as telegram_cli from './source/telegram/cli'
import * as email_cli from './source/email/cli'

async function main() {
  await Promise.allSettled([
    whatsapp_cli.main(),
    telegram_cli.main(),
    email_cli.main(),
  ])
}
```

Use `Promise.allSettled` so a missing credential for one source does not block the others.

### Step 9 — Expose in the HTTP API (per `tasks/server.md`)

`tasks/server.md` already calls for unifying the source views. Once the email source is wired:

- Extend the `/chats` and `/messages` queries in [src/server.ts](src/server.ts) to `UNION ALL` results from `ws_*`, `tg_*`, and `em_*` (or add `/email-chats`, `/email-messages` as a first step).
- Return a `source: 'whatsapp' | 'telegram' | 'email'` discriminator field.
- Reuse the `X-API-KEY` middleware already in place at the top of [src/server.ts](src/server.ts).

### Step 10 — Attachments / media (per `tasks/whatsapp.md`)

If the `media` table is being added at the same time, follow the WhatsApp task:
- Download attachments to `downloads/email/<messageId>/<filename>`.
- Insert a `media` row with `source='email'`, `em_user_id=<from>`, `filename`, `content_type`.
- Store the local path on `em_message` (either add a `media_paths json` column or via the `media` table join).

### Step 11 — Diagnostics

- Use `writeFileSync('raw-message-<id>.json', message)` (from `utils.ts`) in `syncMessage` when a parse error occurs.
- Log all errors with `log.error(...)` (pre-formatted with `[email error]` prefix).

### Step 12 — Tests / smoke checks

- [ ] `npm run test` (i.e. `tsc --noEmit`) passes.
- [ ] `npm run db:dev` regenerates proxy without diff churn.
- [ ] Run `npm start` and verify:
  - Gmail OAuth completes and the existing inbox threads appear as `em_chat` rows.
  - Sending a reply to one of those threads from a different address appears within seconds (Gmail push or IMAP IDLE).
  - Restarting the process reuses the cached `token.json` / IMAP password.
- [ ] Verify reply pairing: a reply creates a new `em_message` in the same `em_chat` (matched by `In-Reply-To` and/or normalized subject).

### Step 13 — Documentation

- [ ] Add a section to the project root `README.md` describing the email source, required env vars, and OAuth setup.
- [ ] Update the multi-source view plan in [tasks/server.md](tasks/server.md) to mention the `em_*` tables.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| New `em_*` namespace | Mirrors `ws_*` / `tg_*`; avoids cross-platform collisions in queries. |
| Subject normalization for chat identity | The Gmail/IMAP concept of "thread" maps cleanly to the existing `em_chat.thread_key` and matches the WhatsApp "one chat per remote user" model. |
| Reuse `In-Reply-To` / `References` for cross-thread merging | If the subject is edited, replies can still be folded into the original thread. |
| One `em_chat` per thread, `em_message.user_id` always = self | Consistent with `ws_chat`; the other participants live on each message. |
| `media` table shared across all sources | Already proposed in [tasks/whatsapp.md](tasks/whatsapp.md); keeps attachments uniform. |
| Lazy / cached authentication | Adapter returns a ready-promise that resolves once on startup, so the same `await adapter.ready` pattern works. |

---

## Open Questions

- [ ] Gmail only (fastest) or also IMAP (broader provider support)? Determines which adapter implementation is shipped first.
- [ ] Should we **send** mail from the same integration (SMTP / Gmail `users.messages.send`), or only read? Affects whether `nodemailer` is needed at v1.
- [ ] Push (Gmail Pub/Sub) vs. polling vs. IMAP `IDLE` for real-time — requires external infra (Pub/Sub topic) or local daemon support.
- [ ] How to handle labels / folders (Gmail) — exposed as additional `em_chat` rows, or as a `folder` column?
- [ ] DKIM / signature verification — out of scope for v1; raw body is sufficient for a chat archive.

---

## Checklist (mirrors `tasks/telegram.md`)

- [ ] Decide provider (Gmail / IMAP / both) and acquire credentials
- [ ] Add env vars in [src/env.ts](src/env.ts)
- [ ] Define `em_user` / `em_chat` / `em_message` (and optional `media`) in [erd.txt](erd.txt)
- [ ] Run `npm run db:dev` to apply schema and regenerate [src/proxy.ts](src/proxy.ts)
- [ ] Implement `src/source/email/utils.ts`
- [ ] Implement `src/source/email/adapter.ts` with `client` / `ready` / `events` / `getAuthState` / `getIdentity`
- [ ] Implement `src/source/email/sync.ts` with `sync()`, `syncMessage()`, `getChatId()`, reply pairing
- [ ] Implement `src/source/email/cli.ts` with the same event wiring as WhatsApp
- [ ] Wire into [src/cli.ts](src/cli.ts) (`Promise.allSettled` to avoid blocking)
- [ ] (Optional) extend the HTTP API in [src/server.ts](src/server.ts) per `tasks/server.md`
- [ ] (Optional) download attachments and populate the shared `media` table
- [ ] Add a section to `README.md` documenting setup
- [ ] Verify `npm run test` passes and a real sync round-trip works
