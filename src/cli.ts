import './server'
import * as whatsapp_cli from './source/whatsapp/cli'
import * as telegram_cli from './source/telegram/cli'
import * as email_cli from './source/email/cli'

async function main() {
  await whatsapp_cli.main()
  await telegram_cli.main()
  await email_cli.main()
}

main().catch(error => {
  console.error(error)
  // process.exit(1)
})
