import { appendEnv, populateEnv } from 'populate-env'
import { loadEmailAccounts } from './source/email/accountsLoader'
import type { EmailAccountConfig } from './source/email/adapter'

let env_template = {
  WS_SESSION_DIR: '.wwebjs_auth',
  WS_CHAT_LIMIT: 3,
  WS_CHAT_LIMIT_MODE: 'fair' as 'fair' | 'first',
  WS_MESSAGE_LIMIT: 32,
  TG_SESSION_DIR: '.tg_auth',
  TG_API_ID: NaN,
  TG_API_HASH: '',
  EMAIL_SESSION_DIR: '.email_auth',
  EMAIL_ACCOUNTS_FILE: '',
  PORT: 3000,
  API_KEY: 'uuid',
}

export let env = {
  ...env_template,
  // resolved list of email accounts (populated after populateEnv)
  EMAIL_ACCOUNTS: [] as EmailAccountConfig[],
}

populateEnv(env_template, { auto_load: true, mode: 'halt' })

// re-merge into env so EMAIL_ACCOUNTS_FILE etc. are visible on env
Object.assign(env, env_template)
env.EMAIL_ACCOUNTS = loadEmailAccounts()

if (env.API_KEY == 'uuid') {
  env.API_KEY = crypto.randomUUID()
  appendEnv({ env: env_template, key: 'API_KEY' })
}
