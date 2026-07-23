export type GmailAccountConfig = {
  user: string
  app_password: string
}

export const GMAIL_IMAP = {
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
}
