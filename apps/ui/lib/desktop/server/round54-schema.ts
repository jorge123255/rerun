import 'server-only'
import type { Client } from '@libsql/client'

export async function initializeDesktopRound54(db: Client) {
    const version = 54, id = 'vault-catalog-account-health'
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (saved && saved.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            await tx.execute(`
                CREATE TABLE desktop_vault_catalog_health (
                    item_id TEXT PRIMARY KEY REFERENCES desktop_vault_mcp_servers(id) ON DELETE CASCADE,
                    revision TEXT NOT NULL,
                    oauth_generation TEXT,
                    launch_nonce TEXT NOT NULL,
                    receipt TEXT NOT NULL
                )
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
