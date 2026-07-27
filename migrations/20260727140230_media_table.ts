import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('media'))) {
    await knex.schema.createTable('media', table => {
      table.increments('id')
      table
        .integer('ws_message_id')
        .unsigned()
        .nullable()
        .unique()
        .references('id')
        .inTable('ws_message')
      table.text('source').notNullable()
      table.text('filename').notNullable()
      table.text('content_type').notNullable()
      table.integer('bytes').nullable()
      table.bigInteger('downloaded_at').nullable()
      table.text('download_error').nullable()
    })
  }

  if (await knex.schema.hasTable('ws_message')) {
    let has_media_id = await knex.schema.hasColumn('ws_message', 'media_id')
    if (!has_media_id) {
      await knex.schema.alterTable('ws_message', table => {
        table
          .integer('media_id')
          .unsigned()
          .nullable()
          .references('id')
          .inTable('media')
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('ws_message')) {
    let has_media_id = await knex.schema.hasColumn('ws_message', 'media_id')
    if (has_media_id) {
      await knex.schema.alterTable('ws_message', table => {
        table.dropColumn('media_id')
      })
    }
  }
  await knex.schema.dropTableIfExists('media')
}
