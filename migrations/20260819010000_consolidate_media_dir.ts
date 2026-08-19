import { Knex } from 'knex'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs'
import { dirname, join } from 'path'

export async function up(_knex: Knex): Promise<void> {
  let root = join('res', 'downloads')
  if (!existsSync(root)) return

  for (let source of readdirSync(root)) {
    let source_dir = join(root, source)
    if (!isDirectory(source_dir)) continue

    moveAll(source_dir, root, source)
    try {
      rmSync(source_dir, { recursive: true, force: true })
    } catch {
      /* keep going */
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
}

function moveAll(source_dir: string, root: string, strip_segment: string) {
  for (let entry of readdirSync(source_dir)) {
    let path = join(source_dir, entry)
    if (isDirectory(path)) {
      moveAll(path, root, strip_segment)
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        /* keep going */
      }
      continue
    }
    let rel = relativeTo(path, root)
    let rel_parts = rel.split(/[\\/]/).filter(Boolean)
    if (rel_parts[0] !== strip_segment) {
      continue
    }
    let new_rel = rel_parts.slice(1).join('/')
    let final_path = join(root, new_rel)
    mkdirSync(dirname(final_path), { recursive: true })
    if (!existsSync(final_path)) {
      renameSync(path, final_path)
    } else if (sameContent(path, final_path)) {
      try {
        rmSync(path, { force: true })
      } catch {
        /* keep going */
      }
    } else {
      throw new Error(
        `hash collision: source=${path} target=${final_path} differ`,
      )
    }
  }
}

function relativeTo(from: string, to: string): string {
  let r = require('path').relative(to, from) as string
  return r.replace(/\\/g, '/')
}

function sameContent(a: string, b: string): boolean {
  let ab = readFileSync(a)
  let bb = readFileSync(b)
  if (ab.length !== bb.length) return false
  for (let i = 0; i < ab.length; i++) if (ab[i] !== bb[i]) return false
  return true
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
