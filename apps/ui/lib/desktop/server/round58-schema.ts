import 'server-only'
import type { Client } from '@libsql/client'

export async function initializeDesktopRound58(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 58, id = 'vault-catalog-sse'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute(`ALTER TABLE desktop_vault_mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'http'
                CHECK(transport IN ('http','sse'))`)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
