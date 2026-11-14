import 'server-only'
import type { Client } from '@libsql/client'

export async function initializeDesktopRound56(db: Client) {
    const version = 56, id = 'vault-catalog-oauth-lineage'
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (saved && saved.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            await tx.execute(`
                CREATE TABLE desktop_vault_catalog_oauth_origin (
                    item_id TEXT PRIMARY KEY REFERENCES desktop_vault_mcp_servers(id) ON DELETE CASCADE,
                    installation_id TEXT NOT NULL UNIQUE REFERENCES desktop_vault_catalog_adoptions(installation_id),
                    config_generation TEXT NOT NULL,
                    token_generation TEXT NOT NULL,
                    source_nonce TEXT NOT NULL
                )
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
            await tx.commit()
        }
    } finally { tx.close() }
}
