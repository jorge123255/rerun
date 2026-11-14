import 'server-only'
import type { Client } from '@libsql/client'

const VERSION = 45
const ID = 'workspace-vault'

export async function initializeDesktopRound45(db: Client) {
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [VERSION] })).rows[0]
        if (saved && saved.id !== ID) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            await tx.executeMultiple(`
                CREATE TABLE desktop_vault_secrets (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, variable TEXT NOT NULL,
                    revision TEXT NOT NULL, value_revision TEXT NOT NULL, sealed TEXT NOT NULL,
                    shared_with_all INTEGER NOT NULL DEFAULT 0 CHECK(shared_with_all IN (0,1))
                );
                CREATE TABLE desktop_vault_attachments (
                    item_id TEXT NOT NULL REFERENCES desktop_vault_secrets(id) ON DELETE CASCADE,
                    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
                    PRIMARY KEY(item_id,agent_id)
                );
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [VERSION, ID] })
        }
        await tx.commit()
    } finally { tx.close() }
}
