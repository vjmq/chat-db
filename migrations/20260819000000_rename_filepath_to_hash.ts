import { Knex } from 'knex'

// replace filepath column with bare sha256 hash
// (path is derived from hash + content_type via resolveMediaPath)
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('media'))) return

  const has_hash = await knex.schema.hasColumn('media', 'hash')
  if (!has_hash) {
    await knex.schema.alterTable('media', table => {
      table.text('hash').nullable()
    })
  }

  const has_filepath = await knex.schema.hasColumn('media', 'filepath')
  if (has_filepath) {
    let rows: Array<{ id: number; filepath: string | null }> =
      await knex('media').select('id', 'filepath').whereNotNull('filepath')
    await knex.transaction(async trx => {
      for (let row of rows) {
        let hash = filepathToHash(row.filepath)
        if (hash == null) continue
        await trx('media').where({ id: row.id }).update({ hash })
      }
    })
    await knex.raw('ALTER TABLE `media` DROP COLUMN `filepath`')
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('media'))) return
  const has_hash = await knex.schema.hasColumn('media', 'hash')
  if (has_hash) {
    await knex.raw('ALTER TABLE `media` DROP COLUMN `hash`')
  }
  const has_filepath = await knex.schema.hasColumn('media', 'filepath')
  if (!has_filepath) {
    await knex.schema.alterTable('media', table => {
      table.text('filepath').nullable()
    })
  }
}

function filepathToHash(filepath: string | null): string | null {
  if (!filepath) return null
  let i = Math.max(
    filepath.lastIndexOf('/'),
    filepath.lastIndexOf('\\'),
  )
  let basename = i >= 0 ? filepath.slice(i + 1) : filepath
  let dot = basename.lastIndexOf('.')
  if (dot < 0) return basename
  return basename.slice(0, dot)
}

