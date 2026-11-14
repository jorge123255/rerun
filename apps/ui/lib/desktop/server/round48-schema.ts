import 'server-only'
import type { Client } from '@libsql/client'

const VERSION = 48
const ID = 'vault-mcp-credential-headers'

export async function initializeDesktopRound48(db: Client) {
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [VERSION] })).rows[0]
        if (saved && saved.id !== ID) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            await tx.execute('ALTER TABLE desktop_vault_mcp_servers ADD COLUMN credential_header TEXT')
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [VERSION, ID] })
        }
        await tx.commit()
    } finally { tx.close() }
}
