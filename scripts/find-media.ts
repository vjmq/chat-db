/**
 * find-media: resolve a media hash (or media row id) to its on-disk path.
 *
 * Usage:
 *   ts-node scripts/find-media.ts <hash-or-id> [...]
 *
 * Each argument may be either:
 *   - a 64-char sha256 hex string (resolves the file path and verifies it
 *     exists on disk; falls back to scanning the shard directory if the
 *     extension guess is wrong), or
 *   - an integer media row id (looks up `hash` and `content_type` in the
 *     `media` table and prints the resolved path).
 *
 * Exit code 0 if every input resolved to a file that exists on disk,
 * 1 otherwise.
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { db } from '../src/db'
import { proxy } from '../src/proxy'

function isHash(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s)
}

function resolveShardDir(
  hash: string,
  source: string = 'whatsapp',
): string {
  return join('res', 'downloads', source, hash.slice(0, 2), hash.slice(2, 4))
}

function findInShard(hash: string, source: string): string | null {
  let dir = resolveShardDir(hash, source)
  if (!existsSync(dir)) return null
  let prefix = hash
  let entries = readdirSync(dir)
  for (let name of entries) {
    if (name.startsWith(prefix)) {
      return join(dir, name)
    }
  }
  return null
}

function resolvePath(
  hash: string,
  content_type: string | null,
  source: string = 'whatsapp',
): string {
  // primary guess from content_type
  if (content_type) {
    let mime = content_type.split('/')[1].split(';')[0]
    let guess = join(
      resolveShardDir(hash, source),
      `${hash}.${mime}`,
    )
    if (existsSync(guess)) return guess
  }
  // fallback: scan shard dir for any file starting with the hash prefix
  let found = findInShard(hash, source)
  if (found) return found
  // last resort: return the mime-derived path even if missing, so callers
  // can see the expected location
  let fallbackExt = content_type
    ? `.${content_type.split('/')[1].split(';')[0]}`
    : '.bin'
  return join(resolveShardDir(hash, source), hash + fallbackExt)
}

function lookupMediaRow(id: number) {
  let row = proxy.media[id]
  if (!row) return null
  return row
}

function main() {
  let args = process.argv.slice(2)
  if (args.length === 0) {
    console.error(
      'usage: ts-node scripts/find-media.ts <hash-or-id> [...]',
    )
    process.exit(2)
  }
  let all_ok = true
  for (let arg of args) {
    if (isHash(arg)) {
      let path = resolvePath(arg.toLowerCase(), null)
      let exists = existsSync(path)
      if (!exists) {
        let stat = (() => {
          try {
            return statSync(path)
          } catch {
            return null
          }
        })()
        if (!stat) all_ok = false
      }
      console.log(`${exists ? 'OK ' : 'MISS'} ${arg} -> ${path}`)
    } else {
      let id = Number(arg)
      if (!Number.isInteger(id) || id <= 0) {
        console.error(`not a hash or row id: ${arg}`)
        all_ok = false
        continue
      }
      let row = lookupMediaRow(id)
      if (!row) {
        console.error(`no media row with id=${id}`)
        all_ok = false
        continue
      }
      if (!row.hash) {
        console.error(`media row id=${id} has no hash`)
        all_ok = false
        continue
      }
      let path = resolvePath(row.hash, row.content_type, row.source)
      let exists = existsSync(path)
      if (!exists) all_ok = false
      console.log(
        `${exists ? 'OK ' : 'MISS'} id=${id} hash=${row.hash} ` +
          `ctype=${row.content_type} -> ${path}`,
      )
    }
  }
  process.exit(all_ok ? 0 : 1)
}

// ensure db is opened (proxy.media requires it)
void db
main()
