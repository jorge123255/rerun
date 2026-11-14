import 'server-only'
import type { Client } from '@libsql/client'

const VERSION = 50
const ID = 'vault-local-program-credentials'

export async function initializeDesktopRound50(db: Client) {
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [VERSION] })).rows[0]
        if (saved && saved.id !== ID) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            await tx.execute(`
                CREATE TABLE desktop_vault_mcp_program_credentials (
                    item_id TEXT NOT NULL REFERENCES desktop_vault_mcp_programs(id) ON DELETE CASCADE,
                    name TEXT NOT NULL, credential_revision TEXT NOT NULL, sealed TEXT NOT NULL,
                    PRIMARY KEY(item_id,name)
                )
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [VERSION, ID] })
        }
        await tx.commit()
    } finally { tx.close() }
}
