import { Knex } from 'knex'

// add `transcript` text column to `media`. Reserved for future
// speech-to-text output; not read by any code path yet.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('media'))) return
  const has_transcript = await knex.schema.hasColumn('media', 'transcript')
  if (!has_transcript) {
    await knex.raw('ALTER TABLE `media` ADD COLUMN `transcript` text NULL')
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('media'))) return
  const has_transcript = await knex.schema.hasColumn('media', 'transcript')
  if (has_transcript) {
    await knex.raw('ALTER TABLE `media` DROP COLUMN `transcript`')
  }
}
