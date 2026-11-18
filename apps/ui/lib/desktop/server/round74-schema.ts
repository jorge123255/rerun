import 'server-only'
import type { Client } from '@libsql/client'

// Older Vaults stored an automatic account number and a user nickname in the same column.
// A matching adoption receipt proves an unchanged imported label. Otherwise keep a recognizable
// original account number; a previously overwritten nickname cannot recover the old default.
export async function initializeDesktopRound74(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 74, id = 'vault-account-default-label'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                ALTER TABLE desktop_vault_mcp_servers ADD COLUMN catalog_default_label TEXT;
                UPDATE desktop_vault_mcp_servers SET catalog_default_label=catalog_label
                WHERE EXISTS (
                    SELECT 1 FROM desktop_vault_catalog_adoptions a
                    WHERE a.item_id=desktop_vault_mcp_servers.id AND a.item_revision=desktop_vault_mcp_servers.revision
                ) OR (catalog_instance IS NOT NULL
                  AND CAST(substr(catalog_label,length(catalog_name)+2) AS INTEGER) >= 2
                  AND catalog_label = catalog_name || ' ' || CAST(substr(catalog_label,length(catalog_name)+2) AS INTEGER));
            `)
            // Sharing rotates the Vault revision while leaving the name alone. Recover an unchanged
            // import when its one retained installation still accounts for the exact display name.
            const hasInstalls = (await tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_service_installs'")).rows.length > 0
            if (hasInstalls) {
                await tx.execute(`
                    UPDATE desktop_vault_mcp_servers AS v SET catalog_default_label=catalog_label
                    WHERE catalog_default_label IS NULL AND catalog_label IS NOT NULL AND EXISTS (
                        SELECT 1 FROM desktop_vault_catalog_adoptions a
                        JOIN desktop_service_installs s ON s.id=a.installation_id AND s.owner=a.owner AND s.engine_id=a.engine_id
                        JOIN desktop_agents owner ON owner.id=a.owner AND owner.engine_agent_id=a.engine_id AND owner.workspace_id=1
                        WHERE a.item_id=v.id AND s.slug=v.catalog_slug
                          AND NOT EXISTS (SELECT 1 FROM desktop_vault_catalog_adoptions other
                                          WHERE other.item_id=a.item_id AND other.installation_id!=a.installation_id)
                          AND v.catalog_label = CASE WHEN json_valid(s.plan) THEN
                              CASE WHEN json_extract(s.plan,'$.label')!='' AND json_extract(s.plan,'$.label')!=json_extract(s.plan,'$.name')
                                   THEN json_extract(s.plan,'$.label') ELSE owner.name END END
                    )`)
            }
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
