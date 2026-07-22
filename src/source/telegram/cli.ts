import { env } from '../../env'
import { attachClient } from '../../server'
import { getClient } from './adapter'
import { sync } from './sync'
import { log } from './utils'

export async function main() {
  let adapter = getClient({
    session_dir: env.TG_SESSION_DIR,
    api_id: env.TG_API_ID,
    api_hash: env.TG_API_HASH,
  })
  adapter.events.on('ready', () => {
    log.client('ready')
  })
  adapter.events.on('qr', qr => {
    log.client('qr', qr)
  })
  adapter.events.on('disconnected', reason => {
    log.client('disconnected', reason)
  })
  adapter.events.on('authenticated', () => {
    log.client('authenticated')
  })
  adapter.events.on('auth_failure', message => {
    log.client('auth_failure', message)
  })
  await adapter.ready
  let tel = await adapter.getTel()
  log.app('client identity:', tel || 'unknown')
  log.app('auth state:', adapter.getAuthState())

  let client = adapter.client

  log.app('syncing messages...')
  await sync(client)
  log.app('synced messages')
}
