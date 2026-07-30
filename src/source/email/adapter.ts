import { mkdirSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import nodemailer, { Transporter } from 'nodemailer'
import { ClientEventMap, AuthState } from '../../utils'
import { log } from './utils'
import { recordSent } from './sync'
import { ImapFlow, ImapAccountConfig } from './providers/imap'
import { GMAIL_IMAP, GMAIL_SMTP, GmailAccountConfig } from './providers/gmail'
import { OUTLOOK_IMAP, OUTLOOK_SMTP, OutlookAccountConfig } from './providers/outlook'

export type EmailProvider = 'gmail' | 'imap' | 'outlook'

export type EmailAccountConfig = {
  id: string
  provider: EmailProvider
  address: string
  gmail?: GmailAccountConfig
  imap?: ImapAccountConfig
  outlook?: OutlookAccountConfig
  mailbox?: string
}

export type EmailClientLike = {
  account: EmailAccountConfig
  provider: EmailProvider
  imap: ImapFlow
  mailbox: string
  send: (opts: {
    to: string
    subject: string
    body: string
    in_reply_to?: string | null
    references?: string | null
  }) => Promise<{ messageId: string }>
}

function resolveSmtpOptions(account: EmailAccountConfig) {
  if (account.provider === 'gmail' && account.gmail) {
    return {
      host: GMAIL_SMTP.host,
      port: GMAIL_SMTP.port,
      secure: GMAIL_SMTP.secure,
      user: account.gmail.user,
      password: account.gmail.app_password,
    }
  }
  if (account.provider === 'outlook' && account.outlook) {
    return {
      host: OUTLOOK_SMTP.host,
      port: OUTLOOK_SMTP.port,
      secure: OUTLOOK_SMTP.secure,
      user: account.outlook.user,
      password: account.outlook.app_password,
    }
  }
  if (account.imap?.smtp) {
    let s = account.imap.smtp
    return {
      host: s.host,
      port: s.port ?? 465,
      secure: s.secure ?? true,
      user: s.user,
      password: s.password,
    }
  }
  throw new Error(`Account ${account.id} has no SMTP config`)
}

function resolveImapOptions(account: EmailAccountConfig) {
  let mailbox = account.mailbox ?? 'INBOX'
  if (account.provider === 'gmail') {
    if (!account.gmail) {
      throw new Error(`Gmail account ${account.id} is missing gmail config`)
    }
    return {
      host: GMAIL_IMAP.host,
      port: GMAIL_IMAP.port,
      tls: GMAIL_IMAP.tls,
      user: account.gmail.user,
      password: account.gmail.app_password,
      mailbox,
    }
  }
  if (account.provider === 'outlook') {
    if (!account.outlook) {
      throw new Error(`Outlook account ${account.id} is missing outlook config`)
    }
    return {
      host: OUTLOOK_IMAP.host,
      port: OUTLOOK_IMAP.port,
      tls: OUTLOOK_IMAP.tls,
      user: account.outlook.user,
      password: account.outlook.app_password,
      mailbox,
    }
  }
  if (!account.imap) {
    throw new Error(`IMAP account ${account.id} is missing imap config`)
  }
  return {
    host: account.imap.host,
    port: account.imap.port ?? 993,
    tls: account.imap.tls ?? true,
    user: account.imap.user,
    password: account.imap.password,
    mailbox: account.imap.mailbox ?? mailbox,
  }
}

export function getClient(options: {
  session_dir: string
  account: EmailAccountConfig
}) {
  let account_dir = join(options.session_dir, options.account.id)
  mkdirSync(account_dir, { recursive: true })

  let events = new EventEmitter<ClientEventMap>()
  let authState: AuthState = 'loading'

  let imap: ImapFlow
  let transporter: Transporter | undefined
  let client: EmailClientLike | undefined
  let mailbox = 'INBOX'

  let ready = new Promise<void>(async (resolve, reject) => {
    try {
      if (!options.account.id || !options.account.address) {
        throw new Error('Email account is missing required fields')
      }
      if (
        options.account.provider !== 'gmail' &&
        options.account.provider !== 'imap' &&
        options.account.provider !== 'outlook'
      ) {
        throw new Error(
          `Unsupported email provider: ${options.account.provider}`,
        )
      }

      let opts = resolveImapOptions(options.account)
      mailbox = opts.mailbox

      imap = new ImapFlow({
        host: opts.host,
        port: opts.port,
        secure: opts.tls,
        auth: { user: opts.user, pass: opts.password },
        logger: false,
      })

      imap.on('error', err => {
        log.client('imap error', options.account.id, err)
        if (authState === 'authenticated') {
          events.emit('disconnected', String(err))
        }
      })
      imap.on('close', () => {
        if (authState === 'authenticated') {
          authState = 'not_authenticated'
          events.emit('disconnected', 'connection closed')
        }
      })

      await imap.connect()
      let lock = await imap.getMailboxLock(mailbox)

      let smtp = resolveSmtpOptions(options.account)
      transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        requireTLS: smtp.port === 587,
        auth: { user: smtp.user, pass: smtp.password },
      })

      async function send(opts: {
        to: string
        subject: string
        body: string
        in_reply_to?: string | null
        references?: string | null
      }) {
        if (!transporter) throw new Error('email client not ready')
        let headers: Record<string, string> = {}
        if (opts.in_reply_to) headers['In-Reply-To'] = opts.in_reply_to
        if (opts.references) headers['References'] = opts.references
        let info = await transporter.sendMail({
          from: options.account.address,
          to: opts.to,
          subject: opts.subject,
          text: opts.body,
          headers,
        })
        let raw = info.messageId ?? ''
        let messageId = raw.replace(/^<|>$/g, '')
        return { messageId }
      }

      client = {
        account: options.account,
        provider: options.account.provider,
        imap,
        mailbox,
        send,
      }

      authState = 'authenticated'
      log.client('authenticated', options.account.id)
      events.emit('authenticated')
      log.client('ready', options.account.id, mailbox)
      events.emit('ready')
      resolve()
      lock.release()
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

  async function disconnect() {
    if (authState === 'not_authenticated') return
    try {
      await imap?.logout()
    } catch {}
    authState = 'not_authenticated'
    log.client('disconnected', options.account.id)
    events.emit('disconnected', 'client stopped')
  }

  return {
    get client(): EmailClientLike {
      if (!client) {
        throw new Error(
          `Email client for ${options.account.id} is not ready yet`,
        )
      }
      return client
    },
    ready,
    events,
    getAuthState,
    getIdentity,
    disconnect,
  }
}
