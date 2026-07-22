# Email API Implementation

- [ ] implement events and getAuthState in email adapter
- [ ] update the cli.ts in email folder, similar to whatsapp
- [ ] define the tables in `erd.txt`
- [ ] create the tables using `npm run db:plan`, and `npm run db:update`
- [ ] implement the sync flow
- [ ] support multiple inboxes (config is a list; one adapter instance per entry)

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

Pick **one** provider for v1, not both:

- **Gmail API** (`googleapis`) — OAuth2, rich metadata, no MIME parsing. Recommended.
- **IMAP + SMTP** (`imapflow` + `mailparser`) — works with any provider (Outlook, Fastmail, self-hosted). Drop `nodemailer` and the Gmail OAuth code if you go this route.

The `if (provider === 'gmail') … else …` branch lives in `adapter.ts`; the rest of the file doesn't need to care.
