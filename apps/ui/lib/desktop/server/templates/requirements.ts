import 'server-only'
import type { Client } from '@libsql/client'
import { desktopTemplateGuidedSetup, type DesktopTemplateRequirement } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'

// Only project setup names. Vault labels, account IDs, endpoints, and values never leave the workspace.
export async function readDesktopPortableSetupRequirements(db: Pick<Client, 'execute'>, owner: { id: string; engineAgentId: string }): Promise<DesktopTemplateRequirement[]> {
    const { rows } = await db.execute({
        sql: `SELECT 'service-reconnect' AS kind, slug AS name
              FROM desktop_service_installs i WHERE owner=? AND engine_id=? AND state != 'removed'
              AND NOT EXISTS (SELECT 1 FROM desktop_vault_catalog_adoptions a WHERE a.installation_id=i.id)
            UNION
            SELECT 'service-reconnect', s.catalog_slug FROM desktop_vault_mcp_servers s
              WHERE s.catalog_slug IS NOT NULL AND (s.shared_with_all=1 OR EXISTS (
                SELECT 1 FROM desktop_vault_mcp_attachments a WHERE a.item_id=s.id AND a.agent_id=?
              ))
            UNION
            SELECT 'environment-key', s.variable FROM desktop_vault_secrets s
              WHERE s.shared_with_all=1 OR EXISTS (
                SELECT 1 FROM desktop_vault_attachments a WHERE a.item_id=s.id AND a.agent_id=?
              )
            ORDER BY kind,name`,
        args: [owner.id, owner.engineAgentId, owner.id, owner.id],
    })
    if (rows.length > 200) throw new DesktopHttpError(413, 'Too many portable setup requirements.')
    return rows.map(row => {
        const name = String(row.name)
        if (row.kind === 'environment-key' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
            return { kind: 'environment-key', name, detail: 'Provide this value locally after installation.' }
        }
        if (row.kind === 'service-reconnect' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) {
            return { kind: 'service-reconnect', name, detail: 'Connect this app locally after installation.' }
        }
        throw new DesktopHttpError(409, 'Portable setup requirement names are not supported.')
    })
}

export function importedTemplateSetup(setup: { required: boolean | null; prompt: string }, rawRequirements: unknown) {
    try { return desktopTemplateGuidedSetup(setup, rawRequirements) }
    catch { throw new DesktopHttpError(409, 'Template setup requirements are not supported') }
}
