import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import { EmailMessage } from './sync'

function extractAddress(
  addr: AddressObject | AddressObject[] | undefined,
): { address: string; name: string | null } {
  if (!addr) return { address: '', name: null }
  let first = Array.isArray(addr) ? addr[0] : addr
  if (!first) return { address: '', name: null }
  let v = first.value?.[0]
  if (!v) return { address: '', name: null }
  return { address: v.address ?? '', name: v.name ?? null }
}

function normalizeSubject(subject: string | undefined): string {
  if (!subject) return ''
  return subject
    .replace(/^(re|fwd|fw)\s*:\s*/i, '')
    .replace(/^\s+|\s+$/g, '')
    .toLowerCase()
}

function pickThreadKey(parsed: ParsedMail): string {
  let inReplyTo = parsed.inReplyTo
  if (typeof inReplyTo === 'string' && inReplyTo.trim()) {
    return inReplyTo.trim()
  }
  let references = parsed.references
  if (typeof references === 'string' && references.trim()) {
    return references.trim().split(/\s+/)[0]
  }
  if (Array.isArray(references) && references.length) {
    return references[0]
  }
  return normalizeSubject(parsed.subject ?? '') || '(no-subject)'
}

function parsedToEmail(
  account_address: string,
  uid: string,
  parsed: ParsedMail,
): EmailMessage | null {
  let from = extractAddress(parsed.from)
  let to = extractAddress(parsed.to)
  let fromAddress = from.address
  let toAddress = to.address || undefined
  if (!fromAddress) return null
  let fromMe = fromAddress.toLowerCase() === account_address.toLowerCase()
  return {
    api_id: uid,
    thread_key: pickThreadKey(parsed),
    from_address: fromAddress,
    from_display_name: from.name,
    to_address: toAddress ?? null,
    to_display_name: to.name,
    body: parsed.text || parsed.html || '',
    timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
    from_me: fromMe,
    message_id_header: parsed.messageId || null,
    in_reply_to:
      typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : null,
    references: Array.isArray(parsed.references)
      ? parsed.references.join(' ')
      : parsed.references || null,
    subject: parsed.subject ?? null,
  }
}

export async function fetchMessages(
  imap: ImapFlow,
  mailbox: string,
  account_address: string,
  since: Date | null,
): Promise<EmailMessage[]> {
  let lock = await imap.getMailboxLock(mailbox)
  try {
    let uids =
      (await imap.search({ since } as any, { uid: true })) as number[]
    if (!uids.length) return []

    let messages: EmailMessage[] = []
    for (let batch of chunk(uids, 25)) {
      let fetched = await imap.fetchAll(
        { uid: batch.join(',') },
        { uid: true, source: true },
      )
      for (let msg of fetched) {
        let source: Buffer | undefined = (msg as any).source
        if (!source) continue
        let parsed = await simpleParser(source)
        let em = parsedToEmail(account_address, String(msg.uid), parsed)
        if (em) messages.push(em)
      }
    }
    return messages
  } finally {
    lock.release()
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  let out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}
