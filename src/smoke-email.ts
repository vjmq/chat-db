import { env } from './env'
import { getClient, EmailAccountConfig } from './source/email/adapter'
import { syncClient } from './source/email/sync'
import { log } from './source/email/utils'
import { db } from './db'

async function main() {
  let accounts: EmailAccountConfig[] = []
  try {
    let parsed = JSON.parse(env.EMAIL_ACCOUNTS)
    if (Array.isArray(parsed)) accounts = parsed
  } catch (error) {
    log.error('failed to parse EMAIL_ACCOUNTS', error)
  }
  if (!accounts.length) {
    log.app('no email accounts configured')
    return
  }

  let adapter = getClient({ session_dir: env.EMAIL_SESSION_DIR, account: accounts[0] })

  adapter.events.on('authenticated', () => log.client('event: authenticated'))
  adapter.events.on('ready', () => log.client('event: ready'))
  adapter.events.on('disconnected', r => log.client('event: disconnected', r))
  adapter.events.on('auth_failure', m => log.client('event: auth_failure', m))

  await adapter.ready
  log.app('mailbox:', adapter.getIdentity())
  log.app('auth:', adapter.getAuthState())

  log.app('starting sync...')
  await syncClient(adapter.client)
  log.app('sync done')

  let row = db.prepare<{ id: string }, { id: string; last_synced_at: number | null }>(
    'select id, last_synced_at from em_account where id = :id',
  ).get({ id: accounts[0].id })
  log.app('account row:', row)

  let messages = db
    .prepare<{ id: string }, { id: string; subject: string | null; timestamp: number }>(
      `select m.id, m.timestamp, c.normalized_subject as subject
       from em_message m join em_chat c on c.id = m.chat_id
       where m.account_id = :id
       order by m.timestamp desc
       limit 10`,
    )
    .all({ id: accounts[0].id })
  log.app('recent messages:', messages)

  await adapter.disconnect()
  log.app('disconnected, exiting')
}

main().catch(err => {
  log.error('smoke test failed', err)
  process.exit(1)
})
