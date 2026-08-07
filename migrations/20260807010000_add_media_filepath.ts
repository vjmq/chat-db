import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('media')) {
    let has_filepath = await knex.schema.hasColumn('media', 'filepath')
    if (!has_filepath) {
      await knex.schema.alterTable('media', table => {
        table.text('filepath').nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('media')) {
    let has_filepath = await knex.schema.hasColumn('media', 'filepath')
    if (has_filepath) {
      await knex.schema.alterTable('media', table => {
        table.dropColumn('filepath')
      })
    }
  }
}
