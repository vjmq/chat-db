import { env } from '../../env'
import { getClient } from './adapter'
import { log } from './utils'

export async function main() {
  let accounts = [] as Array<{ id: string; provider: 'gmail' | 'imap'; address: string }>

  try {
    let parsed = JSON.parse(env.EMAIL_ACCOUNTS)
    if (Array.isArray(parsed)) {
      accounts = parsed
    }
  } catch (error) {
    log.error('failed to parse EMAIL_ACCOUNTS', error)
  }

  if (!accounts.length) {
    log.app('no email accounts configured')
    return
  }

  let adapters = accounts.map(account => {
    let adapter = getClient({
      session_dir: env.EMAIL_SESSION_DIR,
      account,
    })

    adapter.events.on('ready', () => {
      log.client('ready', account.id)
    })
    adapter.events.on('qr', qr => {
      log.client('qr', account.id, qr)
    })
    adapter.events.on('disconnected', reason => {
      log.client('disconnected', account.id, reason)
    })
    adapter.events.on('authenticated', () => {
      log.client('authenticated', account.id)
    })
    adapter.events.on('auth_failure', message => {
      log.client('auth_failure', account.id, message)
    })

    return adapter
  })

  await Promise.allSettled(adapters.map(adapter => adapter.ready))

  for (let adapter of adapters) {
    log.app('mailbox identity:', adapter.getIdentity() || 'unknown')
    log.app('auth state:', adapter.getAuthState())
  }
}
