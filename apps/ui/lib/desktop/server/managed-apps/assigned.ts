import 'server-only'
import type { Client, Transaction } from '@libsql/client'
import { desktopAssignedManagedAccountSchema, type DesktopAssignedManagedAccount } from '../../connector-apps-schema'
import { COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER } from './client'

/** Public assignment metadata for one authenticated coworker. Neither credential material nor remote account IDs leave SQLite. */
export async function assignedManagedAccounts(db: Client, workspaceId: number, agentId: string): Promise<DesktopAssignedManagedAccount[]> {
    const { rows } = await db.execute({
        sql: `WITH owner AS (
            SELECT id, engine_agent_id FROM desktop_agents WHERE id=:owner AND workspace_id=1
            AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=desktop_agents.id OR d.engine_agent_id=desktop_agents.engine_agent_id)
        ), assigned_connect AS (
            SELECT 1 FROM desktop_vault_mcp_servers s, owner
            WHERE s.name='composio' AND s.url=:endpoint AND s.credential_header=:header AND s.sealed IS NOT NULL AND s.catalog_slug IS NULL
            AND (s.shared_with_all=1 OR EXISTS (SELECT 1 FROM desktop_vault_mcp_attachments t WHERE t.item_id=s.id AND t.agent_id=owner.id))
            AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp p WHERE p.agent_id=owner.id AND p.name=s.name)
            AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio p WHERE p.owner=owner.id AND p.name=s.name)
        )
        SELECT a.id,a.slug,a.name,a.label,a.status,CASE WHEN a.user_id='' THEN 'connect' ELSE 'assignment' END AS source
        FROM desktop_managed_app_accounts a
        WHERE (a.user_id='' AND a.connected_account_id='' AND a.status='active' AND EXISTS (SELECT 1 FROM assigned_connect))
           OR ((a.user_id=('rerun_mac_w' || :workspace || '_' || a.id) OR a.user_id=('rerun_mac_' || a.id))
               AND EXISTS (SELECT 1 FROM desktop_managed_app_key WHERE id=1)
               AND EXISTS (SELECT 1 FROM desktop_managed_app_attachments t, owner WHERE t.account_id=a.id AND t.agent_id=owner.id))
        ORDER BY a.name,a.label,a.id LIMIT 200`,
        args: { owner: agentId, workspace: String(workspaceId), endpoint: COMPOSIO_CONNECT, header: COMPOSIO_CONNECT_HEADER },
    })
    return rows.flatMap(row => {
        const account = desktopAssignedManagedAccountSchema.safeParse({ id: row.id, slug: row.slug, name: row.name, ...(typeof row.label === 'string' && row.label && { label: row.label }), status: row.status, source: row.source })
        return account.success ? [account.data] : []
    })
}

/** Clear locally observed Connect sign-ins in the same transaction as removing or changing their key. */
export async function clearConnectAccounts(tx: Transaction) {
    await tx.execute("DELETE FROM desktop_managed_app_attachments WHERE account_id IN (SELECT id FROM desktop_managed_app_accounts WHERE user_id='' AND connected_account_id='')")
    await tx.execute("DELETE FROM desktop_managed_app_accounts WHERE user_id='' AND connected_account_id=''")
}
