import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { desktopVaultListing, type DesktopVaultEntry, type DesktopVaultMutation } from '../../vault'
import { DesktopHttpError } from '../auth'
import { withRosterWrite } from '../roster-writes'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'

async function readVault(tx: Transaction) {
    const coworkers = (await tx.execute(`
        SELECT id,name FROM desktop_agents a WHERE workspace_id=1
        AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id AND d.completed=0)
        ORDER BY name,id`)).rows.map(row => ({ id: String(row.id), name: String(row.name) }))
    const ownerIds = new Set(coworkers.map(row => row.id))
    const attachments = new Map<string, string[]>()
    for (const row of (await tx.execute('SELECT item_id,agent_id FROM desktop_vault_attachments ORDER BY agent_id')).rows) {
        const id = String(row.item_id), agentId = String(row.agent_id)
        if (!ownerIds.has(agentId)) continue
        const agents = attachments.get(id) ?? []
        agents.push(agentId)
        attachments.set(id, agents)
    }
    const entries = (await tx.execute('SELECT id,name,variable,revision,shared_with_all FROM desktop_vault_secrets ORDER BY name,id')).rows.map(row => ({
        id: String(row.id), name: String(row.name), variable: String(row.variable), revision: String(row.revision),
        sharedWithAll: row.shared_with_all === 1, agentIds: attachments.get(String(row.id)) ?? [],
    }))
    return desktopVaultListing.parse({ entries, coworkers })
}

function overlaps(a: DesktopVaultEntry, b: Pick<DesktopVaultEntry, 'agentIds' | 'sharedWithAll'>) {
    if (a.sharedWithAll && b.sharedWithAll) return true
    if (a.sharedWithAll) return b.agentIds.length > 0
    if (b.sharedWithAll) return a.agentIds.length > 0
    return a.agentIds.some(id => b.agentIds.includes(id))
}

export function desktopVault(db: Client, crypto: DesktopSecretCrypto, workspaceId: number) {
    async function seal(id: string, variable: string, revision: string, secret: string) {
        const bytes = Buffer.from(secret, 'utf8')
        try {
            return await crypto.seal({ domain: 'vault', agentId: id, key: variable, version: 1, workspaceId, revision }, bytes)
        } finally { bytes.fill(0) }
    }

    return {
        async list() {
            const tx = await db.transaction('read')
            try { return await readVault(tx) } finally { tx.close() }
        },
        mutate(input: DesktopVaultMutation, assertCurrent: () => void) {
            return withRosterWrite(async () => {
                assertCurrent()
                const tx = await db.transaction('write')
                try {
                    const revision = randomUUID()
                    if (input.operation === 'create') {
                        const id = randomUUID()
                        const sealed = await seal(id, input.variable, revision, input.value)
                        assertCurrent()
                        await tx.execute({
                            sql: 'INSERT INTO desktop_vault_secrets(id,name,variable,revision,value_revision,sealed) VALUES(?,?,?,?,?,?)',
                            args: [id, input.name, input.variable, revision, revision, sealed],
                        })
                    } else {
                        const listing = await readVault(tx)
                        const entry = listing.entries.find(row => row.id === input.id)
                        if (!entry) throw new DesktopHttpError(404, 'Vault entry not found.')
                        if (input.revision !== entry.revision) throw new DesktopHttpError(409, 'This Vault entry changed. Reopen it and try again.')
                        if (input.operation === 'share') {
                            const agentIds = [...new Set(input.agentIds)]
                            if (agentIds.some(id => !listing.coworkers.some(agent => agent.id === id))) {
                                throw new DesktopHttpError(409, 'A selected coworker is no longer in this workspace.')
                            }
                            const other = listing.entries.find(row => row.id !== entry.id && row.variable === entry.variable && overlaps(row, { ...input, agentIds }))
                            if (other) throw new DesktopHttpError(409, `A coworker would receive ${entry.variable} from both ${entry.name} and ${other.name}.`, 'vault_conflict')
                            await tx.execute({ sql: 'DELETE FROM desktop_vault_attachments WHERE item_id=?', args: [entry.id] })
                            for (const id of agentIds) await tx.execute({ sql: 'INSERT INTO desktop_vault_attachments(item_id,agent_id) VALUES(?,?)', args: [entry.id, id] })
                            await tx.execute({ sql: 'UPDATE desktop_vault_secrets SET revision=?,shared_with_all=? WHERE id=?', args: [revision, Number(input.sharedWithAll), entry.id] })
                        } else if (input.operation === 'replace') {
                            const sealed = await seal(entry.id, entry.variable, revision, input.value)
                            await tx.execute({ sql: 'UPDATE desktop_vault_secrets SET revision=?,value_revision=?,sealed=? WHERE id=?', args: [revision, revision, sealed, entry.id] })
                        } else {
                            await tx.execute({ sql: 'DELETE FROM desktop_vault_attachments WHERE item_id=?', args: [entry.id] })
                            await tx.execute({ sql: 'DELETE FROM desktop_vault_secrets WHERE id=?', args: [entry.id] })
                        }
                    }
                    const result = await readVault(tx)
                    assertCurrent()
                    await tx.commit()
                    return result
                } finally { tx.close() }
            })
        },
    }
}
