import 'server-only'

import { randomUUID } from 'node:crypto'
import { desktopServiceVaultAccountSchema, type DesktopServiceChoice, type DesktopServiceConnection } from '@rerun/contracts'
import { desktopVaultHealthReceipt } from '../../vault'
import { DesktopHttpError } from '../auth'
import type { ServiceRequestDatabase } from './service'

export async function readServiceVaultAccounts(db: ServiceRequestDatabase, ownerId: string, launchNonce: string, now = Date.now()) {
    const result = await db.execute({
        sql: `SELECT s.id,s.revision,s.catalog_slug,s.catalog_label,s.catalog_name,s.oauth_enabled,h.receipt,
                 s.shared_with_all=1 OR t.item_id IS NOT NULL AS attached
            FROM desktop_vault_mcp_servers s
            JOIN desktop_agents a ON a.id=? AND a.workspace_id=1
            JOIN desktop_vault_catalog_health h ON h.item_id=s.id AND h.revision=s.revision AND h.launch_nonce=?
            LEFT JOIN desktop_vault_mcp_oauth o ON o.item_id=s.id
            LEFT JOIN desktop_vault_mcp_attachments t ON t.item_id=s.id AND t.agent_id=a.id
            WHERE s.catalog_slug IS NOT NULL AND h.oauth_generation IS o.generation
              AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
              AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp p WHERE p.agent_id=a.id AND p.name=s.name)
              AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio p WHERE p.owner=a.id AND p.name=s.name)
              AND NOT EXISTS (SELECT 1 FROM desktop_service_installs p WHERE p.owner=a.id AND json_extract(p.plan,'$.serverName')=s.name)
            ORDER BY s.catalog_slug,COALESCE(s.catalog_label,s.catalog_name),s.id`,
        args: [ownerId, launchNonce],
    })
    return result.rows.flatMap(row => {
        const health = desktopVaultHealthReceipt.parse(JSON.parse(String(row.receipt)))
        const checked = Date.parse(health.checkedAt)
        const expires = Math.min(checked + 60_000, row.oauth_enabled === 1 ? Date.parse(health.credentialExpiresAt ?? '') : Infinity)
        if (health.state !== 'healthy' || !health.toolCount || now < checked || !(now < expires)) return []
        const id = String(row.id)
        const view = desktopServiceVaultAccountSchema.parse({
            key: 'vault:' + id, revision: row.revision, slug: row.catalog_slug, label: row.catalog_label ?? row.catalog_name,
        })
        return [{ id, view, attached: Number(row.attached) === 1, expires }]
    })
}

export type ServiceVaultAccount = Awaited<ReturnType<typeof readServiceVaultAccounts>>[number]

export function vaultConnection(account: ServiceVaultAccount): DesktopServiceConnection {
    return { ...account.view, state: 'ready', healthState: 'healthy', usable: true }
}

/** Called in the same write transaction that seals the app decision. A failed
 * decision rolls back the assignment together with its receipt. */
export async function attachServiceVaultAccounts(db: ServiceRequestDatabase, ownerId: string, accounts: ServiceVaultAccount[], choices: DesktopServiceChoice[]) {
    const selected: ServiceVaultAccount[] = []
    for (const choice of choices) {
        if (choice.choice !== 'use-connection' || !choice.installation.key.startsWith('vault:')) continue
        const account = accounts.find(item => item.view.key === choice.installation.key && item.view.revision === choice.installation.revision && item.view.slug === choice.slug)
        if (!account || Date.now() >= account.expires) throw new DesktopHttpError(409, 'That Vault account changed or its connection check expired. Check it again in Vault.')
        if (!account.attached) {
            const count = await db.execute({ sql: 'SELECT COUNT(*) AS total FROM desktop_vault_mcp_attachments WHERE item_id=?', args: [account.id] })
            if (Number(count.rows[0]?.total) >= 250) throw new DesktopHttpError(409, 'This Vault account already has the maximum number of assignments.')
            const nextRevision = randomUUID()
            await db.execute({ sql: 'INSERT INTO desktop_vault_mcp_attachments(item_id,agent_id) VALUES(?,?)', args: [account.id, ownerId] })
            const updated = await db.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET revision=? WHERE id=? AND revision=?', args: [nextRevision, account.id, account.view.revision] })
            if (updated.rowsAffected !== 1) throw new DesktopHttpError(409, 'That Vault account changed. Refresh the card and choose again.')
            await db.execute({ sql: 'UPDATE desktop_vault_catalog_health SET revision=? WHERE item_id=? AND revision=?', args: [nextRevision, account.id, account.view.revision] })
        }
        selected.push(account)
    }
    return selected
}
