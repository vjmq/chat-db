import './server'
import { env } from './env'
import * as whatsapp_cli from './source/whatsapp/cli'
import * as telegram_cli from './source/telegram/cli'
import * as email_cli from './source/email/cli'

async function main() {
  await whatsapp_cli.main()
  if (env.TG_API_ID > 0 && env.TG_API_HASH && env.TG_API_HASH !== 'stub') {
    await telegram_cli.main()
  } else {
    console.log('[cli] telegram skipped: TG_API_ID / TG_API_HASH not configured')
  }
  await email_cli.main()
}

main().catch(error => {
  console.error(error)
  // process.exit(1)
})
