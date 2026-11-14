import 'server-only'
import type { Client } from '@libsql/client'

export async function initializeDesktopRound53(db: Client) {
    const version = 53, id = 'vault-catalog-account-labels'
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (saved && saved.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            await tx.executeMultiple(`
                ALTER TABLE desktop_vault_mcp_servers ADD COLUMN catalog_instance TEXT;
                ALTER TABLE desktop_vault_mcp_servers ADD COLUMN catalog_label TEXT;
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
