# Email API Implementation

- [x] implement events and getAuthState in email adapter
- [x] update the cli.ts in email folder, similar to whatsapp
- [x] define the tables in `erd.txt`
- [x] create the tables using `npm run db:plan`, and `npm run db:update`
- [x] implement the sync flow (implemented framework)
- [x] support multiple inboxes (config is a list; one adapter instance per entry)

## Notes

- Mirror the `telegram/` and `whatsapp/` 4-file layout: `adapter.ts`, `cli.ts`, `sync.ts`, `utils.ts`. `utils.ts` is `makeSourceUtils({ source: 'email' })`.
- Use the existing `ClientEventMap` / `AuthState` types from `src/utils.ts`.
- `getClient` returns `{ client, ready, events, getAuthState, getIdentity }`; `getIdentity()` returns the mailbox address (analogous to `getTel()`).

### Multiple inboxes

Email has no single self-user per adapter and no group-chat concept. The simplest approach that matches the rest of the codebase:

- Keep the 4-file layout, but make the adapter **parameterized by a single account**.
- Hold the list of accounts in `env.EMAIL_ACCOUNTS` (a `EmailAccountConfig[]` resolved at startup).
- Iterate the list in `cli.ts`, calling `getClient({ account })` per entry and awaiting each `ready` in parallel with `Promise.allSettled` (so a bad account doesn't block the others).
- Per-account state lives under `${EMAIL_SESSION_DIR}/${account.id}/` (e.g. `token.json`).

#### Configuring accounts

The legacy `EMAIL_ACCOUNTS=[…]` single-line JSON is gone. Two new shapes are supported (see `accountsLoader.ts`):

1. **`EMAIL_ACCOUNTS_FILE=accounts.json`** (preferred). Point at a pretty-printed JSON array. A tracked `accounts.example.json` is provided as a starting template; copy it to `accounts.json` and fill in your credentials.
2. **Indexed env blocks** for fully-inline `.env` setups:
   ```dotenv
   EMAIL_ACCOUNTS_1_ID=personal-gmail
   EMAIL_ACCOUNTS_1_PROVIDER=gmail
   EMAIL_ACCOUNTS_1_ADDRESS=you@gmail.com
   EMAIL_ACCOUNTS_1_GMAIL_USER=you@gmail.com
   EMAIL_ACCOUNTS_1_GMAIL_APP_PASSWORD=abcd efgh ijkl mnop

   EMAIL_ACCOUNTS_2_ID=work-imap
   EMAIL_ACCOUNTS_2_PROVIDER=imap
   EMAIL_ACCOUNTS_2_ADDRESS=you@work.example.com
   EMAIL_ACCOUNTS_2_IMAP_HOST=mail.work.example.com
   EMAIL_ACCOUNTS_2_IMAP_PORT=993
   EMAIL_ACCOUNTS_2_IMAP_USER=you@work.example.com
   EMAIL_ACCOUNTS_2_IMAP_PASSWORD=secret
   EMAIL_ACCOUNTS_2_IMAP_SMTP_HOST=smtp.work.example.com
   EMAIL_ACCOUNTS_2_IMAP_SMTP_PORT=465
   EMAIL_ACCOUNTS_2_IMAP_SMTP_USER=you@work.example.com
   EMAIL_ACCOUNTS_2_IMAP_SMTP_PASSWORD=secret
   ```
   Nested fields use a flat dot-style prefix (`IMAP_SMTP_HOST` → `imap.smtp.host`). Blocks are auto-discovered by index. `EMAIL_ACCOUNTS_FILE` is checked first; if it is set, the indexed blocks are ignored.

The per-account shape is the same in both forms — see `accounts.example.json` for one of each kind (Gmail, Outlook, IMAP+SMTP).

### Schema (`erd.txt`)

Add an `em_*` block. Same conventions as `ws_*` / `tg_*`:

- `em_account` — one row per configured inbox (PK = stable `id` from config; `provider`, `address`, `session_dir`, `last_synced_at`). The natural anchor because email has no self-user.
- `em_user` — one row per email address, shared across all accounts.
- `em_chat` — one thread per `(account_id, normalized_subject)`. Uniqueness is `UNIQUE(account_id, thread_key)` so the same subject on two inboxes stays two separate chats. No `user_id` self-link (participants live on each message).
- `em_message` — anchored to `account_id` and `chat_id`. Uniqueness is `UNIQUE(account_id, api_id)` (Gmail `messageId` / IMAP `UID` are only unique per account). Stores `from_user_id`, `to_user_id`, `body`, `timestamp`, `from_me`, plus `message_id_header` / `in_reply_to` / `references` for reply pairing.
- Reuse the shared `media` table (per `tasks/whatsapp.md`); add an `account_id` FK and a `source = 'email'` value, so attachments stay uniform across all sources.

### Library choice

**IMAP + SMTP via `imapflow` + `mailparser` + `nodemailer`.** Outlook is on the roadmap and it speaks IMAP too, so one shared code path covers Gmail, Outlook, iCloud, Fastmail, and self-hosted.

- No OAuth dance — use **app passwords** (Gmail under 2FA, Outlook.com too).
- Thread pairing via `Message-ID` / `In-Reply-To` / `References` headers; `X-GM-THRID` for Gmail thread IDs.
- Real-time is polling (IMAP `IDLE` is fragile). Polling every ~60s is fine for chat-DB sync.

```bash
npm install imapflow mailparser nodemailer
npm install -D @types/mailparser @types/nodemailer
```

### Provider setup

All three providers use the same `imapflow` client; only the host / credentials differ. The SMTP hosts live in `src/source/email/providers/{gmail,outlook,imap}.ts`.

| Provider | `provider` | IMAP host                     | SMTP host                       | Auth shape                                          |
| -------- | ---------- | ----------------------------- | ------------------------------- | --------------------------------------------------- |
| Gmail    | `gmail`    | `imap.gmail.com:993`          | `smtp.gmail.com:465`            | `gmail: { user, app_password }`                     |
| Outlook  | `outlook`  | `imap-mail.outlook.com:993`   | `smtp.office365.com:587` (STARTTLS) | `outlook: { user, app_password }`                |
| Generic  | `imap`     | configurable                  | configurable                    | `imap: { host, port, user, password, tls, mailbox, smtp: { ... } }` |

For each provider:

1. Enable 2FA on the account.
2. Create an app password (Gmail: `myaccount.google.com → Security → 2-Step Verification → App passwords`; Outlook: `account.microsoft.com → Security → Advanced security options → App passwords`).
3. Add an `EMAIL_ACCOUNTS` entry (in `accounts.json` or as indexed `EMAIL_ACCOUNTS_N_*` env blocks — see [Configuring accounts](#configuring-accounts) above).
4. Run `npm start` — the account boots in parallel with any other entries.

### Sending

Already wired via `nodemailer` in `adapter.ts`. `send(client, { to, subject, body })` returns the IMAP `Message-ID` so replies can be paired. The `if (provider === 'gmail' || provider === 'outlook') … else …` branch lives in `adapter.ts`; the rest of the file doesn't need to care.
