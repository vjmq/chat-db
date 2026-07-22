import { mkdirSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { ClientEventMap, AuthState } from '../../utils'
import { log } from './utils'

export type EmailProvider = 'gmail' | 'imap'

export type EmailAccountConfig = {
  id: string
  provider: EmailProvider
  address: string
  gmail?: Record<string, unknown>
  imap?: Record<string, unknown>
}

export type EmailClientLike = {
  account: EmailAccountConfig
  provider: EmailProvider
}

export function getClient(options: {
  session_dir: string
  account: EmailAccountConfig
}) {
  let account_dir = join(options.session_dir, options.account.id)
  mkdirSync(account_dir, { recursive: true })

  let client: EmailClientLike = {
    account: options.account,
    provider: options.account.provider,
  }

  let events = new EventEmitter<ClientEventMap>()
  let authState: AuthState = 'loading'

  let ready = new Promise<void>((resolve, reject) => {
    try {
      if (!options.account.id || !options.account.address) {
        throw new Error('Email account is missing required fields')
      }
      if (
        options.account.provider !== 'gmail' &&
        options.account.provider !== 'imap'
      ) {
        throw new Error(
          `Unsupported email provider: ${options.account.provider}`,
        )
      }

      authState = 'authenticated'
      log.client('authenticated', options.account.id)
      events.emit('authenticated')
      log.client('ready', options.account.id)
      events.emit('ready')
      resolve()
    } catch (error) {
      authState = 'not_authenticated'
      log.client('auth_failure', options.account.id, error)
      events.emit('auth_failure', error)
      reject(error)
    }
  })

  function getIdentity() {
    return options.account.address || null
  }

  function getAuthState() {
    return authState
  }

  function disconnect() {
    if (authState !== 'not_authenticated') {
      authState = 'not_authenticated'
      log.client('disconnected', options.account.id)
      events.emit('disconnected', 'client stopped')
    }
  }

  return {
    client,
    ready,
    events,
    getAuthState,
    getIdentity,
    disconnect,
  }
}
