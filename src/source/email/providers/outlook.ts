export type OutlookAccountConfig = {
  user: string
  app_password: string
}

export const OUTLOOK_IMAP = {
  host: 'imap-mail.outlook.com',
  port: 993,
  tls: true,
}

export const OUTLOOK_SMTP = {
  host: 'smtp.office365.com',
  port: 587,
}