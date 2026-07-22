import { appendEnv, populateEnv } from 'populate-env'

export let env = {
  WS_SESSION_DIR: '.wwebjs_auth',
  TG_SESSION_DIR: '.tg_auth',
  TG_API_ID: NaN,
  TG_API_HASH: '',
  EMAIL_SESSION_DIR: '.email_auth',
  EMAIL_ACCOUNTS: '[]',
  PORT: 3000,
  API_KEY: 'uuid',
}

populateEnv(env, { auto_load: true, mode: 'halt' })

if (env.API_KEY == 'uuid') {
  env.API_KEY = crypto.randomUUID()
  appendEnv({ env, key: 'API_KEY' })
}
