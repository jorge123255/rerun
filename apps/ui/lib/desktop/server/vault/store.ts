import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { desktopCoworkerVaultListing, desktopVaultListing, type DesktopCoworkerVaultMutation, type DesktopCoworkerVaultEntry, type DesktopVaultEntry, type DesktopVaultListing, type DesktopVaultMutation } from '../../vault'
import { DesktopHttpError } from '../auth'
import { endpoint } from '../mcp/model'
import { oauthHttps } from '../mcp/oauth-network'
import { withRosterWrite } from '../roster-writes'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'

async function readVault(tx: Transaction) {
    const coworkers = (await tx.execute(`
        SELECT id,name FROM desktop_agents a WHERE workspace_id=1
        AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id AND d.completed=0)
        ORDER BY name,id`)).rows.map(row => ({ id: String(row.id), name: String(row.name) }))
    const ownerIds = new Set(coworkers.map(row => row.id))
    const attachments = new Map<string, string[]>()
    for (const row of (await tx.execute('SELECT item_id,agent_id FROM desktop_vault_attachments UNION ALL SELECT item_id,agent_id FROM desktop_vault_mcp_attachments ORDER BY agent_id')).rows) {
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
    const servers = (await tx.execute('SELECT id,name,url,revision,sealed IS NOT NULL AND credential_header IS NULL AS has_bearer,credential_header,shared_with_all FROM desktop_vault_mcp_servers ORDER BY name,id')).rows.map(row => ({
        kind: 'mcp', id: String(row.id), name: String(row.name), url: String(row.url), revision: String(row.revision),
        sharedWithAll: row.shared_with_all === 1, hasBearer: row.has_bearer === 1, ...(typeof row.credential_header === 'string' && { headerName: row.credential_header }), agentIds: attachments.get(String(row.id)) ?? [],
    }))
    return desktopVaultListing.parse({ entries: [...servers, ...entries], coworkers })
}

function requireCoworker(listing: DesktopVaultListing, agentId: string) {
    if (!listing.coworkers.some(coworker => coworker.id === agentId)) {
        throw new DesktopHttpError(404, 'Coworker not found in this workspace.')
    }
}

function coworkerListing(listing: DesktopVaultListing, agentId: string) {
    requireCoworker(listing, agentId)
    const attached: DesktopCoworkerVaultEntry[] = []
    const available: typeof attached = []
    for (const { agentIds, ...entry } of listing.entries) {
        const group = entry.sharedWithAll || agentIds.includes(agentId) ? attached : available
        group.push(entry)
    }
    return desktopCoworkerVaultListing.parse({ agentId, attached, available })
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

    function sealServerCredential(id: string, url: string, revision: string, input: { bearer: string } | { header: { name: string; value: string } }) {
        if ('header' in input) return seal(id, JSON.stringify([url, input.header.name]), revision, input.header.value)
        return input.bearer ? seal(id, url, revision, input.bearer) : null
    }

    async function list() {
        const tx = await db.transaction('read')
        try { return await readVault(tx) } finally { tx.close() }
    }

    function mutate(change: DesktopVaultMutation | (DesktopCoworkerVaultMutation & { operation: 'coworker'; agentId: string }), assertCurrent: () => void) {
        return withRosterWrite(async () => {
            assertCurrent()
            const tx = await db.transaction('write')
            try {
                const revision = randomUUID()
                const listing = await readVault(tx)
                let input: DesktopVaultMutation
                if (change.operation === 'coworker') {
                    requireCoworker(listing, change.agentId)
                    const entry = listing.entries.find(row => row.id === change.id)
                    if (!entry) throw new DesktopHttpError(404, 'Vault entry not found.')
                    if (entry.revision !== change.revision) throw new DesktopHttpError(409, 'This Vault entry changed. Reopen it and try again.')
                    if (entry.sharedWithAll) throw new DesktopHttpError(409, 'This entry is shared with every coworker. Change it in the workspace Vault.')
                    if (change.attached && entry.agentIds.length >= 250 && !entry.agentIds.includes(change.agentId)) {
                        throw new DesktopHttpError(409, 'This entry already has the maximum number of individual assignments.')
                    }
                    const assigned = entry.agentIds.includes(change.agentId)
                    if (assigned === change.attached) {
                        assertCurrent()
                        return listing
                    }
                    input = {
                        operation: 'share', id: change.id, revision: change.revision, sharedWithAll: false,
                        agentIds: change.attached ? [...entry.agentIds, change.agentId] : entry.agentIds.filter(id => id !== change.agentId),
                    }
                } else input = change
                if (input.operation === 'create') {
                    const id = randomUUID()
                    const sealed = await seal(id, input.variable, revision, input.value)
                    assertCurrent()
                    await tx.execute({
                        sql: 'INSERT INTO desktop_vault_secrets(id,name,variable,revision,value_revision,sealed) VALUES(?,?,?,?,?,?)',
                        args: [id, input.name, input.variable, revision, revision, sealed],
                    })
                } else if (input.operation === 'create-server') {
                    let url: string
                    try { url = oauthHttps(endpoint(input.url)).href }
                    catch { throw new DesktopHttpError(400, 'Enter a public HTTPS MCP endpoint without a query or credentials.') }
                    if (listing.entries.some(entry => 'kind' in entry && entry.name === input.name)) {
                        throw new DesktopHttpError(409, 'An MCP server already uses this name in the Vault.', 'vault_conflict')
                    }
                    const id = randomUUID()
                    await tx.execute({
                        sql: 'INSERT INTO desktop_vault_mcp_servers(id,name,url,revision,credential_revision,sealed,credential_header) VALUES(?,?,?,?,?,?,?)',
                        args: [id, input.name, url, revision, revision, await sealServerCredential(id, url, revision, input.header ? { header: input.header } : { bearer: input.bearer }), input.header?.name ?? null],
                    })
                } else {
                    const entry = listing.entries.find(row => row.id === input.id)
                    if (!entry) throw new DesktopHttpError(404, 'Vault entry not found.')
                    if (input.revision !== entry.revision) throw new DesktopHttpError(409, 'This Vault entry changed. Reopen it and try again.')
                    if (input.operation === 'share') {
                        const agentIds = [...new Set(input.agentIds)]
                        if (agentIds.some(id => !listing.coworkers.some(agent => agent.id === id))) {
                            throw new DesktopHttpError(409, 'A selected coworker is no longer in this workspace.')
                        }
                        const targets = new Set((input.sharedWithAll ? listing.coworkers.map(agent => agent.id) : agentIds)
                            .filter(id => !entry.sharedWithAll && !entry.agentIds.includes(id)))
                        const server = 'kind' in entry
                        if (server) {
                            const collisions = await tx.execute({
                                sql: 'SELECT agent_id FROM desktop_remote_mcp WHERE name=? UNION ALL SELECT owner AS agent_id FROM desktop_mcp_stdio WHERE name=?',
                                args: [entry.name, entry.name],
                            })
                            if (collisions.rows.some(row => targets.has(String(row.agent_id)))) {
                                throw new DesktopHttpError(409, `A selected coworker already has an MCP server named ${entry.name}.`, 'vault_conflict')
                            }
                        } else {
                            const other = listing.entries.find(row => !('kind' in row) && row.id !== entry.id && row.variable === entry.variable && overlaps(row, { ...input, agentIds }))
                            if (other) throw new DesktopHttpError(409, `A coworker would receive ${entry.variable} from both ${entry.name} and ${other.name}.`, 'vault_conflict')
                            if (targets.size) {
                                const privateCredentials = await tx.execute({ sql: 'SELECT agent_id FROM desktop_secret_credentials WHERE key=?', args: [entry.variable] })
                                if (privateCredentials.rows.some(row => targets.has(String(row.agent_id)))) {
                                    throw new DesktopHttpError(409, `A selected coworker already has a private credential named ${entry.variable}.`, 'vault_conflict')
                                }
                            }
                        }
                        const table = server ? 'desktop_vault_mcp_servers' : 'desktop_vault_secrets'
                        const attachments = server ? 'desktop_vault_mcp_attachments' : 'desktop_vault_attachments'
                        await tx.execute({ sql: `DELETE FROM ${attachments} WHERE item_id=?`, args: [entry.id] })
                        for (const id of agentIds) await tx.execute({ sql: `INSERT INTO ${attachments}(item_id,agent_id) VALUES(?,?)`, args: [entry.id, id] })
                        await tx.execute({ sql: `UPDATE ${table} SET revision=?,shared_with_all=? WHERE id=?`, args: [revision, Number(input.sharedWithAll), entry.id] })
                    } else if (input.operation === 'replace-server-bearer' || input.operation === 'replace-server-header') {
                        if (!('kind' in entry)) throw new DesktopHttpError(400, 'This entry is not an MCP server.')
                        const sealed = await sealServerCredential(entry.id, entry.url, revision, input)
                        await tx.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET revision=?,credential_revision=?,sealed=?,credential_header=? WHERE id=?', args: [revision, revision, sealed, 'header' in input ? input.header.name : null, entry.id] })
                    } else if (input.operation === 'replace') {
                        if ('kind' in entry) throw new DesktopHttpError(400, 'This entry is not a standalone secret.')
                        const sealed = await seal(entry.id, entry.variable, revision, input.value)
                        await tx.execute({ sql: 'UPDATE desktop_vault_secrets SET revision=?,value_revision=?,sealed=? WHERE id=?', args: [revision, revision, sealed, entry.id] })
                    } else if ('kind' in entry) {
                        await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_attachments WHERE item_id=?', args: [entry.id] })
                        await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_servers WHERE id=?', args: [entry.id] })
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
    }

    return {
        list,
        mutate(input: DesktopVaultMutation, assertCurrent: () => void) { return mutate(input, assertCurrent) },
        async forCoworker(agentId: string) { return coworkerListing(await list(), agentId) },
        async assignCoworker(agentId: string, input: DesktopCoworkerVaultMutation, assertCurrent: () => void) {
            return coworkerListing(await mutate({ ...input, operation: 'coworker', agentId }, assertCurrent), agentId)
        },
    }
}
