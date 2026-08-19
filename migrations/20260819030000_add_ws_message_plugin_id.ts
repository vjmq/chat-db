import { Knex } from 'knex'

// add `plugin_id` text column to `ws_message`. Reserved for future
// plugin-attribution metadata; not read by any code path yet
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('ws_message'))) return
  const has_plugin_id = await knex.schema.hasColumn('ws_message', 'plugin_id')
  if (!has_plugin_id) {
    await knex.raw('ALTER TABLE `ws_message` ADD COLUMN `plugin_id` text NULL')
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('ws_message'))) return
  const has_plugin_id = await knex.schema.hasColumn('ws_message', 'plugin_id')
  if (has_plugin_id) {
    await knex.raw('ALTER TABLE `ws_message` DROP COLUMN `plugin_id`')
  }
}
