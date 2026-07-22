import { mkdirSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { ClientEventMap, AuthState } from '../../utils'

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

      authState = 'authenticated'
      events.emit('authenticated')
      events.emit('ready')
      resolve()
    } catch (error) {
      authState = 'not_authenticated'
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

  return {
    client,
    ready,
    events,
    getAuthState,
    getIdentity,
  }
}
