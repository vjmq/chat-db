import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('ws_chat')) {
    let has_media_filenames = await knex.schema.hasColumn(
      'ws_chat',
      'media_filenames',
    )
    if (!has_media_filenames) {
      await knex.schema.alterTable('ws_chat', table => {
        table.json('media_filenames').nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('ws_chat')) {
    let has_media_filenames = await knex.schema.hasColumn(
      'ws_chat',
      'media_filenames',
    )
    if (has_media_filenames) {
      await knex.schema.alterTable('ws_chat', table => {
        table.dropColumn('media_filenames')
      })
    }
  }
}
