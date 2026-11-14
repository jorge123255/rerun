import 'server-only'
import type { Client } from '@libsql/client'
import { foremanConversationColumns, foremanHomeIndex } from './foreman/chat-store'

const VERSION = 43
const ID = 'foreman-conversations'

export async function initializeDesktopRound43(db: Client) {
    const previous = (await db.execute({
        sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [VERSION],
    })).rows[0]
    if (previous) {
        if (previous.id !== ID) throw new Error('Desktop migration identity mismatch')
        return
    }

    // libSQL migrates in one transaction with foreign-key enforcement suspended, so
    // replacing the parent table never cascades into saved turns, attachments or voice.
    // The check runs before commit, while the original tables can still be restored.
    await db.migrate([
        `CREATE TABLE desktop_foreman_chats_new(${foremanConversationColumns})`,
        `INSERT INTO desktop_foreman_chats_new(chat_id,workspace_id,engine_session_id,model,ui,ui_revision)
         SELECT chat_id,workspace_id,engine_session_id,model,ui,ui_revision FROM desktop_foreman_chats ORDER BY rowid`,
        'DROP TABLE desktop_foreman_chats',
        'ALTER TABLE desktop_foreman_chats_new RENAME TO desktop_foreman_chats',
        foremanHomeIndex,
        'CREATE TEMP TABLE foreman_migration_integrity(ok INTEGER CHECK(ok = 1))',
        'INSERT INTO foreman_migration_integrity VALUES(NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check))',
        'DROP TABLE foreman_migration_integrity',
        { sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [VERSION, ID] },
    ])
}
