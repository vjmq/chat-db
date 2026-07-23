import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('em_account'))) {
    await knex.schema.createTable('em_account', table => {
      table.text('id').primary()
      table.text('provider').notNullable()
      table.text('address').notNullable()
      table.text('session_dir').notNullable()
      table.bigInteger('last_synced_at').nullable()
    })
  }

  if (!(await knex.schema.hasTable('em_user'))) {
    await knex.schema.createTable('em_user', table => {
      table.increments('id')
      table.text('address').notNullable().unique()
      table.text('display_name').nullable()
    })
  }

  if (!(await knex.schema.hasTable('em_chat'))) {
    await knex.schema.createTable('em_chat', table => {
      table.increments('id')
      table.text('account_id').notNullable().references('em_account.id')
      table.text('thread_key').notNullable()
      table.text('normalized_subject').nullable()
      table.integer('last_message_id').nullable()
      table.unique(['account_id', 'thread_key'])
    })
  }

  if (!(await knex.schema.hasTable('em_message'))) {
    await knex.schema.createTable('em_message', table => {
      table.increments('id')
      table.text('account_id').notNullable().references('em_account.id')
      table.integer('chat_id').unsigned().notNullable().references('em_chat.id')
      table.text('api_id').notNullable()
      table.bigInteger('timestamp').notNullable()
      table.integer('from_user_id').unsigned().notNullable().references('em_user.id')
      table.integer('to_user_id').unsigned().nullable().references('em_user.id')
      table.text('body').notNullable()
      table.boolean('from_me').notNullable()
      table.text('message_id_header').nullable()
      table.text('in_reply_to').nullable()
      table.text('references').nullable()
      table.unique(['account_id', 'api_id'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('em_message')
  await knex.schema.dropTableIfExists('em_chat')
  await knex.schema.dropTableIfExists('em_user')
  await knex.schema.dropTableIfExists('em_account')
}
