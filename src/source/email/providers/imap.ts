import { ImapFlow } from 'imapflow'

export type ImapAccountConfig = {
  host: string
  port?: number
  user: string
  password: string
  tls?: boolean
  mailbox?: string
}

export { ImapFlow }
