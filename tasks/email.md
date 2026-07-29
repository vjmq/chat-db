# Email API Implementation

- [x] implement events and getAuthState in email adapter
- [x] update the cli.ts in email folder, similar to whatsapp
- [x] define the tables in `erd.txt`
- [x] create the tables using `npm run db:plan`, and `npm run db:update`
- [x] implement the sync flow (implemented framework)
- [x] support multiple inboxes (config is a list; one adapter instance per entry)

## Notes

- Mirror the `telegram/` and `whatsapp/` 4-file layout: `adapter.ts`, `cli.ts`, `sync.ts`, `utils.ts`.
- `utils.ts` is just `makeSourceUtils({ source: 'email' })` — same as the other sources.
- Use the existing `ClientEventMap` / `AuthState` types from `src/utils.ts`.
- `getClient` returns `{ client, ready, events, getAuthState, getIdentity }`; `getIdentity()` returns the mailbox address (analogous to `getTel()`).

### Multiple inboxes

Unlike WhatsApp / Telegram, email has no single self-user per adapter and no group-chat concept. The simplest approach that matches the rest of the codebase:

- Keep the 4-file layout, but make the adapter **parameterized by a single account**.
- Hold the list of accounts in `env.EMAIL_ACCOUNTS` (a JSON array — id, provider, address, plus a `gmail` or `imap` block).
- Iterate the list in `cli.ts`, calling `getClient({ account })` per entry and awaiting each `ready` in parallel with `Promise.allSettled` (so a bad account doesn't block the others). No extra `accounts.ts` module.
- Per-account state lives under `${EMAIL_SESSION_DIR}/${account.id}/` (e.g. `token.json`).

### Schema (`erd.txt`)

Add an `em_*` block. Same conventions as `ws_*` / `tg_*`:

- `em_account` — one row per configured inbox (PK = stable `id` from config; columns for `provider`, `address`, `session_dir`, `last_synced_at`). The natural anchor because email has no self-user.
- `em_user` — one row per email address, shared across all accounts.
- `em_chat` — one thread per `(account_id, normalized_subject)`. Uniqueness is `UNIQUE(account_id, thread_key)` so the same subject on two inboxes stays two separate chats. No `user_id` self-link (email has no group-chat concept; participants live on each message).
- `em_message` — anchored to `account_id` and `chat_id`. Uniqueness is `UNIQUE(account_id, api_id)` (Gmail `messageId` / IMAP `UID` are only unique per account). Store `from_user_id`, `to_user_id`, `body`, `timestamp`, `from_me`, plus `message_id_header` / `in_reply_to` / `references` for reply pairing.
- Reuse the shared `media` table (per `tasks/whatsapp.md`); add an `account_id` FK and a `source = 'email'` value, so attachments stay uniform across all sources.

### Library choice

**IMAP + SMTP via `imapflow` + `mailparser`**. Outlook is on the roadmap and it speaks IMAP too, so one shared code path covers Gmail, Outlook, iCloud, Fastmail, and self-hosted.

- No OAuth dance — use **app passwords** (Gmail under 2FA, Outlook.com too).
- Thread pairing via `Message-ID` / `In-Reply-To` / `References` headers; `X-GM-THRID` for Gmail thread IDs.
- Real-time is polling (IMAP `IDLE` is fragile). Polling every ~60s is fine for chat-DB sync.

Install:

```bash
npm install imapflow mailparser
npm install -D @types/mailparser
```

### Sending (later)

When sending is needed, add `nodemailer` and use the same SMTP credentials already in the `gmail` / `outlook` / `imap` block (Gmail: `smtp.gmail.com:465` over TLS; Outlook: `smtp.office365.com:587` with STARTTLS; generic IMAP providers: their published SMTP host). Wire it into `adapter.ts` as a thin `send(client, { to, subject, body })` that returns the IMAP `Message-ID` so replies can be paired.

```bash
npm install nodemailer
npm install -D @types/nodemailer
```

The `if (provider === 'gmail' || provider === 'outlook') … else …` branch lives in `adapter.ts`; the rest of the file doesn't need to care.

### Outlook accounts

Outlook.com / Hotmail / Live addresses can be added with `provider: 'outlook'` and the same `user` / `app_password` shape as Gmail. The adapter resolves them via the shared `imapflow` client (host `imap-mail.outlook.com:993`, TLS).

Setup:

1. Enable 2FA on the Microsoft account.
2. Create an **app password** at `account.microsoft.com → Security → Advanced security options → App passwords`.
3. Add an entry to `EMAIL_ACCOUNTS`:

   ```json
   {
     "id": "personal-outlook",
     "provider": "outlook",
     "address": "[email protected]",
     "outlook": {
       "user": "[email protected]",
       "app_password": "abcd efgh ijkl mnop"
     }
   }
   ```

4. Run `npm start` — the account boots in parallel with any Gmail entries.

The Outlook path uses the same `em_*` schema and the same `syncClient` logic as Gmail; only the IMAP host/credentials differ.

### Gmail accounts

Gmail addresses use `provider: 'gmail'` with the same `user` / `app_password` shape. The adapter resolves them via the shared `imapflow` client (host `imap.gmail.com:993`, TLS).

Setup:

1. Enable 2-Step Verification on the Google account.
2. Create an **app password** at `myaccount.google.com → Security → 2-Step Verification → App passwords`.
3. Add an entry to `EMAIL_ACCOUNTS`:

   ```json
   {
     "id": "personal-gmail",
     "provider": "gmail",
     "address": "[email protected]",
     "gmail": {
       "user": "[email protected]",
       "app_password": "abcd efgh ijkl mnop"
     }
   }
   ```

4. Run `npm start` — the account boots in parallel with any other entries.

For generic IMAP providers (iCloud, Fastmail, self-hosted, etc.), use `provider: 'imap'` and supply `imap: { host, port, user, password, tls, mailbox }` directly.
