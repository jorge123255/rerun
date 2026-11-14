import 'server-only'
import type { DesktopMcpSecretOpener } from '../mcp-secret-references/lookup'
import type { DesktopMcpSecretReferenceExecutor } from '../mcp-secret-references/store'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'

// MCP bindings store integer versions. Keep Vault and private credential identities disjoint.
const VAULT_VERSION_BASE = 2 ** 48

async function readCredential(db: DesktopMcpSecretReferenceExecutor, agentId: string, key: string) {
    const { rows } = await db.execute({ sql: `
        SELECT 'private' AS source, c.version, NULL AS item_id, NULL AS value_revision
        FROM desktop_secret_credentials c WHERE c.agent_id=? AND c.key=?
        UNION ALL
        SELECT 'vault', g.generation, v.id, v.value_revision
        FROM desktop_vault_secrets v
        JOIN desktop_vault_credential_generations g ON g.item_id=v.id
        JOIN desktop_agents a ON a.id=? AND a.workspace_id=1
        WHERE v.variable=?
        AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id AND d.completed=0)
        AND (v.shared_with_all=1 OR EXISTS (
            SELECT 1 FROM desktop_vault_attachments t WHERE t.item_id=v.id AND t.agent_id=a.id
        ))
        LIMIT 2`, args: [agentId, key, agentId, key] })
    if (!rows.length) return null
    if (rows.length !== 1) throw new Error('Multiple credentials match this reference.')
    const row = rows[0]
    const version = Number(row.version)
    if (!Number.isSafeInteger(version) || version <= 0) throw new Error('Invalid credential version.')
    if (row.source === 'private') {
        if (version >= VAULT_VERSION_BASE) throw new Error('Invalid private credential version.')
        return { source: 'private' as const, version }
    }
    const generation = VAULT_VERSION_BASE + version
    if (!Number.isSafeInteger(generation)) throw new Error('Invalid Vault credential generation.')
    return { source: 'vault' as const, version: generation, id: String(row.item_id), valueRevision: String(row.value_revision) }
}

export async function readDesktopMcpCredentialVersion(db: DesktopMcpSecretReferenceExecutor, agentId: string, key: string) {
    return (await readCredential(db, agentId, key))?.version
}

export function desktopVaultMcpOpener(db: DesktopMcpSecretReferenceExecutor, crypto: DesktopSecretCrypto, workspaceId: number, privateOpener: DesktopMcpSecretOpener): DesktopMcpSecretOpener {
    return {
        async useCredential(agentId, key, authority, consume) {
            await authority.check({ agentId, key })
            const selected = await readCredential(db, agentId, key)
            if (!selected) throw new Error('Credential not found for this coworker.')
            const check = async () => {
                const current = await readCredential(db, agentId, key)
                if (!current || current.version !== selected.version) throw new Error('Credential changed before use.')
                await authority.check({ agentId, key, version: selected.version })
            }
            await check()
            if (selected.source === 'private') {
                return privateOpener.useCredential(agentId, key, {
                    async check(credential) {
                        await authority.check(credential)
                        await check()
                    },
                }, consume)
            }

            const row = (await db.execute({
                sql: 'SELECT sealed FROM desktop_vault_secrets WHERE id=? AND value_revision=?',
                args: [selected.id, selected.valueRevision],
            })).rows[0]
            if (!row) throw new Error('Credential changed before use.')
            const value = await crypto.open({
                domain: 'vault', agentId: selected.id, key, version: 1, workspaceId, revision: selected.valueRevision,
            }, String(row.sealed))
            try {
                await check()
                return await consume(value)
            } finally { value.fill(0) }
        },
    }
}
