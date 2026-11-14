import 'server-only'
import type { Client } from '@libsql/client'

export async function initializeDesktopRound57(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 57, id = 'vault-catalog-skills'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute(`CREATE TABLE desktop_vault_catalog_skill_sets (
                owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
                item_id TEXT NOT NULL,
                installation_id TEXT NOT NULL UNIQUE,
                engine_id TEXT NOT NULL,
                PRIMARY KEY(owner,item_id)
            )`)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
