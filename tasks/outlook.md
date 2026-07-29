# Outlook Integration

Mirror the Gmail/IMAP path. Outlook.com speaks IMAP, so the existing `imapflow` provider covers it — just add a preset.

## Checklist

- [ ] add `outlook` preset in `src/source/email/providers/` (host `imap-mail.outlook.com`, port 993, TLS). Extend `EmailProvider` union in `adapter.ts`.
- [ ] document Outlook app-password setup in `email.md`; allow `outlook` entries in `EMAIL_ACCOUNTS` config (`provider: 'outlook'`, `user`, `app_password`).
- [ ] reuse `em_*` tables from `erd.txt` — no schema changes needed.
- [ ] verify `syncClient` correctly threads Outlook-specific quirks (folder name is `INBOX`, same as IMAP; `Message-ID` / `In-Reply-To` pairing works the same).
- [ ] add reconnect/backoff and per-account error isolation (same patterns already in place for Gmail).
- [ ] sending (later): use `smtp.office365.com:587` STARTTLS with the same app password via `nodemailer`.

## Notes

- No new dependencies — Outlook.com is plain IMAP.
- OAuth (Graph API) is out of scope; app password is sufficient and matches the Gmail path.
- Per-account `last_synced_at` cursor in `em_account` already isolates sync state, so adding Outlook accounts doesn't disturb Gmail.
