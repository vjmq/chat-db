import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { log } from './utils'
import { EmailAccountConfig } from './adapter'

// resolves the email account list from one of two env-driven inputs

export function loadEmailAccounts(): EmailAccountConfig[] {
  let source = process.env

  if (source.EMAIL_ACCOUNTS && source.EMAIL_ACCOUNTS.trim() !== '[]') {
    log.error(
      'EMAIL_ACCOUNTS=<json> is no longer supported. ' +
        'Use EMAIL_ACCOUNTS_FILE=/path/to/accounts.json ' +
        'or indexed EMAIL_ACCOUNTS_N_* env blocks instead.',
    )
  }

  // 1) Preferred: file-based JSON
  let file_path = source.EMAIL_ACCOUNTS_FILE
  if (file_path) {
    return loadFromFile(file_path)
  }

  // 2) Fallback: indexed blocks
  let indexed = loadFromIndexedBlocks(source)
  if (indexed.length > 0) {
    return indexed
  }

  return []
}

function loadFromFile(file_path: string): EmailAccountConfig[] {
  let resolved = resolve(process.cwd(), file_path)
  if (!existsSync(resolved)) {
    log.error(`EMAIL_ACCOUNTS_FILE not found: ${resolved}`)
    return []
  }
  try {
    let raw = readFileSync(resolved, 'utf8')
    let parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      log.error(
        `EMAIL_ACCOUNTS_FILE must contain a JSON array, got ${typeof parsed}`,
      )
      return []
    }
    return parsed as EmailAccountConfig[]
  } catch (error) {
    log.error(`failed to parse EMAIL_ACCOUNTS_FILE (${resolved})`, error)
    return []
  }
}

const PREFIX = 'EMAIL_ACCOUNTS_'

function loadFromIndexedBlocks(
  source: NodeJS.ProcessEnv,
): EmailAccountConfig[] {
  let groups = new Map<number, Record<string, string>>()
  for (let key of Object.keys(source)) {
    if (!key.startsWith(PREFIX)) continue
    let rest = key.slice(PREFIX.length)
    let m = /^(\d+)_(.*)$/.exec(rest)
    if (!m) continue
    let index = Number(m[1])
    let field = m[2]
    let value = source[key]
    if (value === undefined) continue
    if (!groups.has(index)) groups.set(index, {})
    groups.get(index)![field] = value
  }

  if (groups.size === 0) return []

  let accounts: EmailAccountConfig[] = []
  let indexes = Array.from(groups.keys()).sort((a, b) => a - b)
  for (let index of indexes) {
    let flat = groups.get(index)!
    let account = expandFlatKeys(flat)
    if (account) accounts.push(account)
  }
  return accounts
}

/**
 * Flattens EMAIL_ACCOUNTS_N_<FIELD> keys into a nested EmailAccountConfig.
 * - Top-level scalar keys (PROVIDER, ADDRESS, ID, MAILBOX) map directly.
 * - Keys with a single underscore-separated segment after a known provider
 *   (GMAIL_*, OUTLOOK_*, IMAP_*) are placed under that provider's sub-object.
 * - IMAP_SMTP_* keys are nested under imap.smtp.
 */
function expandFlatKeys(
  flat: Record<string, string>,
): EmailAccountConfig | null {
  let id = flat.ID
  let provider = (flat.PROVIDER ?? '').toLowerCase()
  let address = flat.ADDRESS

  if (!id || !provider || !address) {
    if (Object.keys(flat).length > 0) {
      log.error(
        `email account block missing required field (id/provider/address): ${JSON.stringify(flat)}`,
      )
    }
    return null
  }

  if (provider !== 'gmail' && provider !== 'imap' && provider !== 'outlook') {
    log.error(`unsupported email provider in env: ${provider}`)
    return null
  }

  let account: EmailAccountConfig = {
    id,
    provider,
    address,
  }
  if (flat.MAILBOX) account.mailbox = flat.MAILBOX

  let gmail: Record<string, string> = {}
  let outlook: Record<string, string> = {}
  let imap: Record<string, string> = {}
  let imap_smtp: Record<string, string> = {}

  for (let [key, value] of Object.entries(flat)) {
    let k = key.toUpperCase()
    if (k === 'ID' || k === 'PROVIDER' || k === 'ADDRESS' || k === 'MAILBOX') {
      continue
    }
    if (k.startsWith('GMAIL_')) {
      gmail[low(k.slice('GMAIL_'.length))] = value
      continue
    }
    if (k.startsWith('OUTLOOK_')) {
      outlook[low(k.slice('OUTLOOK_'.length))] = value
      continue
    }
    if (k.startsWith('IMAP_SMTP_')) {
      imap_smtp[low(k.slice('IMAP_SMTP_'.length))] = value
      continue
    }
    if (k.startsWith('IMAP_')) {
      imap[low(k.slice('IMAP_'.length))] = value
      continue
    }
    log.error(`unknown email account field: ${key}`)
  }

  if (provider === 'gmail' && Object.keys(gmail).length) {
    account.gmail = gmail as any
  }
  if (provider === 'outlook' && Object.keys(outlook).length) {
    account.outlook = outlook as any
  }
  if (provider === 'imap' && Object.keys(imap).length) {
    if (Object.keys(imap_smtp).length) {
      ;(imap as any).smtp = imap_smtp
    }
    account.imap = imap as any
  }

  return account
}

function low(s: string): string {
  return s.toLowerCase()
}
