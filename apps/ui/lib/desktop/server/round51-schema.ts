import 'server-only'
import type { Client } from '@libsql/client'

const VERSION = 51
const ID = 'vault-mcp-browser-oauth'

export async function initializeDesktopRound51(db: Client) {
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [VERSION] })).rows[0]
        if (saved && saved.id !== ID) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            await tx.executeMultiple(`
                ALTER TABLE desktop_vault_mcp_servers ADD COLUMN oauth_enabled INTEGER NOT NULL DEFAULT 0 CHECK(oauth_enabled IN (0,1));
                CREATE TABLE desktop_vault_mcp_oauth (
                    item_id TEXT PRIMARY KEY REFERENCES desktop_vault_mcp_servers(id) ON DELETE CASCADE,
                    generation TEXT NOT NULL, sealed TEXT NOT NULL
                );
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [VERSION, ID] })
        }
        await tx.commit()
    } finally { tx.close() }
}
