import 'server-only'
import type { Client } from '@libsql/client'

export const vaultCatalogAdoptionSchema = `
    CREATE TABLE desktop_vault_catalog_adoptions (
        installation_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_revision TEXT NOT NULL
    );
    CREATE INDEX desktop_vault_catalog_adoption_item ON desktop_vault_catalog_adoptions(item_id, owner);
`

export async function initializeDesktopRound55(db: Client) {
    const version = 55, id = 'vault-catalog-adoption'
    const tx = await db.transaction('write')
    try {
        const saved = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (saved && saved.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!saved) {
            // The receipt outlives deleting a Vault item. Startup cannot resurrect a detached login.
            await tx.executeMultiple(vaultCatalogAdoptionSchema)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
