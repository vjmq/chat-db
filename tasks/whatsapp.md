support audio, image, video (download and save)

- save to fs, e.g. `downloads/whatsapp/xxx.ogg`
- link in database

```
media
-----
id pk
ws_message_id fk null unique
source text
filename text
content_type text
bytes int null
downloaded_at int null
download_error text null
```

- ws_message gains `media_id` FK to `media.id` (nullable)

# Steps

1. Schema
   - add `media` table to `erd.txt` (columns above)
   - add `ws_message.media_id` (FK → `media.id`, nullable)
   - new migration `migrations/<ts>_media_table.ts`: create `media`, alter `ws_message` to add `media_id`
   - run `npm run db:update` to regenerate `src/proxy.ts`

2. Download helper (`src/source/whatsapp/sync.ts`)
   - `downloadMessageMedia(message): number | null`
     - if `!message.hasMedia` return null
     - call `message.downloadMedia()` → `{ mimetype, data (base64), filename }`
     - choose filename: prefer `media.filename` if it has an extension, else `<api_id>.<ext-from-mimetype>`
     - write to `res/downloads/whatsapp/<filename>` (mkdir -p)
     - `seedRow` into `proxy.media` with `{ ws_message_id, source: 'whatsapp', filename, content_type, bytes, downloaded_at: now }`
     - return `media_id`
   - guard whole thing in `try/catch`: on failure, `seedRow` with `download_error` set and return null (don't break the sync)

3. Wire into `syncMessage`
   - after the `ws_message` upsert, if the row is new (id changed) or `has_media` is true and `media_id` is null, call `downloadMessageMedia(message)` and update the message row's `media_id`
   - keep `syncMessage` as a single `db.transaction`

4. Wire into live path (`src/source/whatsapp/cli.ts`)
   - in the `client.on('message', …)` handler, after `syncMessage` returns, if the message has media and the saved row's `media_id` is null, call the same downloader (pass the message through)

5. Server surface (`src/server.ts`)
   - `GET /chats/whatsapp/:id/media?type=ptt` — list media rows for a chat, joined with `ws_message` for `timestamp` and `from_user_id` (the "annotated and timestamped" listing)
   - `GET /media/:id` — stream the file from `res/downloads/whatsapp/<filename>` with the stored `content_type`

6. Verify
   - `npm test` (tsc --noEmit)
   - manual: `npm start`, send a voice note to a test chat, confirm file appears in `res/downloads/whatsapp/` and the new endpoints return it
