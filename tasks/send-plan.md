# Email Sending (nodemailer)

Add `send()` to the email adapter so Gmail and Outlook accounts can dispatch mail via SMTP, using the same app-password credentials already in `EMAIL_ACCOUNTS`. Sent `Message-ID` is returned so replies can be paired into the existing `em_message` thread.

## Steps

1. **Install** `nodemailer` and `@types/nodemailer`. No other new deps.
2. **Extend provider presets** in `src/source/email/providers/`:
   - `gmail.ts` — export `GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465, secure: true }`.
   - `outlook.ts` — keep `OUTLOOK_SMTP = { host: 'smtp.office365.com', port: 587, secure: false }` (STARTTLS via `requireTLS: true`).
   - `imap.ts` — generic fallback reads an `smtp` block from `account.imap` (host/port/user/pass).
3. **Add `send()` to `EmailClientLike`** in `src/source/email/adapter.ts`:
   - `resolveSmtpOptions(account)` mirrors `resolveImapOptions` (branches `gmail` / `outlook` / `imap`).
   - Build `nodemailer.createTransport({ host, port, secure, auth, requireTLS: port === 587 })`.
   - Method: `async function send({ to, subject, body })` → `transporter.sendMail({ from: account.address, to, subject, text })` → return `{ messageId }` (stripped of angle brackets so it matches inbound `inReplyTo` form).
4. **Pair into sync** in `src/source/email/sync.ts` — after `send()` succeeds, call `syncMessage(...)` locally so the outgoing row is in `em_message` with `from_me = true` and `message_id_header` set. Lets the next inbound reply thread onto it via `inReplyTo`.
5. **Verify**:
   - `npx tsc --noEmit` (no schema change → no migration).
   - Manual: send a test message from a configured Gmail and Outlook account, then call `syncClient` and confirm the reply lands in the same `em_chat.thread_key` (proves `inReplyTo` pairing).

## Relevant files

- `src/source/email/providers/gmail.ts` — add `GMAIL_SMTP`.
- `src/source/email/providers/outlook.ts` — confirm `OUTLOOK_SMTP`.
- `src/source/email/providers/imap.ts` — generic `smtp` fallback.
- `src/source/email/adapter.ts` — `resolveSmtpOptions`, `send()`, extend `EmailClientLike`.
- `src/source/email/sync.ts` — call `syncMessage` from `send()` so outgoing mail is in `em_message`.

## Decisions

- App password (not OAuth) — matches the existing ingestion path.
- STARTTLS for Outlook (`587`), implicit TLS for Gmail (`465`) — per provider docs.
- No schema change — `em_message.message_id_header` / `in_reply_to` / `references` already store what we need.
- Text-only (`body`) for v1 — HTML/attachments deferred.

## Out of scope

- ~~HTTP route (`POST /email/send`) — separate task~~ — added in 2026-07-30 (see "Route usage" below).

## Route usage

After `emailClients` is populated by `email_cli.main()`, the server exposes:

```
POST /email/send
Headers: X-API-KEY: <env.API_KEY>
Body:    { "account_id": "<id from EMAIL_ACCOUNTS>",
           "to":         "recipient@example.com",
           "subject":    "Hello",
           "body":       "Plain-text body",
           "in_reply_to": "<optional Message-ID of an inbound message>",
           "references":  "<optional References header>" }
Response: { "messageId": "<Message-ID, angle brackets stripped>" }
```

Example:

```bash
curl -X POST http://localhost:3000/email/send \
  -H "X-API-KEY: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"account_id":"acc-1","to":"x@example.com","subject":"hi","body":"hello"}'
```

To reply to an inbound message, pass its `message_id_header` as `in_reply_to` (and the same value in `references` if you have it). The outgoing row is written via `recordSent` with `from_me = 1`, so the next inbound reply threads onto the same `em_chat.thread_key` automatically. `404` means the `account_id` is not in `EMAIL_ACCOUNTS` (or its adapter is disconnected — it is removed from the map on `disconnected` and re-added on reconnect).
