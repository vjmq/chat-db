import { ImapFlow } from 'imapflow'

export type ImapAccountConfig = {
  host: string
  port?: number
  user: string
  password: string
  tls?: boolean
  mailbox?: string
  smtp?: ImapSmtpConfig
}

export type ImapSmtpConfig = {
  host: string
  port?: number
  user: string
  password: string
  secure?: boolean
}

export { ImapFlow }
