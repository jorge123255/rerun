import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { desktopCoworkerVaultListing, desktopVaultListing, desktopVaultProgramCredentialLimit, type DesktopCoworkerVaultMutation, type DesktopCoworkerVaultEntry, type DesktopVaultEntry, type DesktopVaultListing, type DesktopVaultMutation } from '../../vault'
import { DesktopHttpError } from '../auth'
import { executableIdentity } from '../mcp-stdio/process'
import { endpoint } from '../mcp/model'
import { oauthHttps } from '../mcp/oauth-network'
import { withRosterWrite } from '../roster-writes'
import { vaultProgramCredentialContext } from './mcp-programs'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'

async function readVault(tx: Transaction) {
    const coworkers = (await tx.execute(`
        SELECT id,name FROM desktop_agents a WHERE workspace_id=1
        AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id AND d.completed=0)
        ORDER BY name,id`)).rows.map(row => ({ id: String(row.id), name: String(row.name) }))
    const ownerIds = new Set(coworkers.map(row => row.id))
    const attachments = new Map<string, string[]>()
    for (const row of (await tx.execute('SELECT item_id,agent_id FROM desktop_vault_attachments UNION ALL SELECT item_id,agent_id FROM desktop_vault_mcp_attachments UNION ALL SELECT item_id,agent_id FROM desktop_vault_mcp_program_attachments ORDER BY agent_id')).rows) {
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
    const credentialNames = new Map<string, string[]>()
    for (const row of (await tx.execute('SELECT item_id,name FROM desktop_vault_mcp_program_credentials ORDER BY name')).rows) {
        const id = String(row.item_id)
        const names = credentialNames.get(id) ?? []
        names.push(String(row.name))
        credentialNames.set(id, names)
    }
    const programs = (await tx.execute('SELECT id,name,executable,args,revision,shared_with_all FROM desktop_vault_mcp_programs ORDER BY name,id')).rows.map(row => ({
        kind: 'program', id: String(row.id), name: String(row.name), executable: String(row.executable), args: JSON.parse(String(row.args)), revision: String(row.revision), credentialNames: credentialNames.get(String(row.id)) ?? [],
        sharedWithAll: row.shared_with_all === 1, agentIds: attachments.get(String(row.id)) ?? [],
    }))
    return desktopVaultListing.parse({ entries: [...servers, ...programs, ...entries], coworkers })
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
        if ('kind' in entry && entry.kind === 'program') {
            const { id, name, kind, executable, revision, sharedWithAll } = entry
            group.push({ id, name, kind, executable, revision, sharedWithAll })
        } else group.push(entry)
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
            let approvedExecutable: string | undefined
            if (change.operation === 'create-program' || change.operation === 'replace-program') {
                if (Buffer.byteLength(JSON.stringify(change.args)) > 32_768) throw new DesktopHttpError(400, 'Local MCP arguments are too large.')
                try { approvedExecutable = await executableIdentity(change.executable, AbortSignal.timeout(3000)) }
                catch { throw new DesktopHttpError(400, 'Choose an installed executable at its canonical path, owned by this Mac user or root.') }
                assertCurrent()
            }
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
                } else if (input.operation === 'create-program') {
                    if (listing.entries.some(entry => 'kind' in entry && entry.name === input.name)) {
                        throw new DesktopHttpError(409, 'An MCP server already uses this name in the Vault.', 'vault_conflict')
                    }
                    await tx.execute({
                        sql: 'INSERT INTO desktop_vault_mcp_programs(id,name,executable,args,executable_identity,revision) VALUES(?,?,?,?,?,?)',
                        args: [randomUUID(), input.name, input.executable, JSON.stringify(input.args), approvedExecutable!, revision],
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
                        const table = server ? entry.kind === 'program' ? 'desktop_vault_mcp_programs' : 'desktop_vault_mcp_servers' : 'desktop_vault_secrets'
                        const attachments = server ? entry.kind === 'program' ? 'desktop_vault_mcp_program_attachments' : 'desktop_vault_mcp_attachments' : 'desktop_vault_attachments'
                        await tx.execute({ sql: `DELETE FROM ${attachments} WHERE item_id=?`, args: [entry.id] })
                        for (const id of agentIds) await tx.execute({ sql: `INSERT INTO ${attachments}(item_id,agent_id) VALUES(?,?)`, args: [entry.id, id] })
                        await tx.execute({ sql: `UPDATE ${table} SET revision=?,shared_with_all=? WHERE id=?`, args: [revision, Number(input.sharedWithAll), entry.id] })
                    } else if (input.operation === 'replace-program') {
                        if (!('kind' in entry) || entry.kind !== 'program') throw new DesktopHttpError(400, 'This entry is not a local MCP program.')
                        const prior = (await tx.execute({ sql: 'SELECT executable_identity,args FROM desktop_vault_mcp_programs WHERE id=?', args: [entry.id] })).rows[0]
                        if (entry.executable !== input.executable || prior.executable_identity !== approvedExecutable || prior.args !== JSON.stringify(input.args)) {
                            await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_program_credentials WHERE item_id=?', args: [entry.id] })
                        }
                        await tx.execute({
                            sql: 'UPDATE desktop_vault_mcp_programs SET executable=?,args=?,executable_identity=?,revision=? WHERE id=?',
                            args: [input.executable, JSON.stringify(input.args), approvedExecutable!, revision, entry.id],
                        })
                    } else if (input.operation === 'set-program-credential' || input.operation === 'remove-program-credential') {
                        if (!('kind' in entry) || entry.kind !== 'program') throw new DesktopHttpError(400, 'This entry is not a local MCP program.')
                        const exists = entry.credentialNames.includes(input.variable)
                        if (input.operation === 'set-program-credential') {
                            if (!exists && entry.credentialNames.length >= desktopVaultProgramCredentialLimit) {
                                throw new DesktopHttpError(409, 'This program already has the maximum number of credentials.')
                            }
                            const row = (await tx.execute({ sql: 'SELECT executable_identity,args FROM desktop_vault_mcp_programs WHERE id=?', args: [entry.id] })).rows[0]
                            const context = vaultProgramCredentialContext(workspaceId, {
                                id: entry.id, executable: entry.executable, approvedExecutable: String(row.executable_identity), args: String(row.args),
                            }, input.variable, revision)
                            const value = Buffer.from(input.value, 'utf8')
                            let sealed: string
                            try { sealed = await crypto.seal(context, value) }
                            finally { value.fill(0) }
                            await tx.execute({
                                sql: `INSERT INTO desktop_vault_mcp_program_credentials(item_id,name,credential_revision,sealed) VALUES(?,?,?,?)
                                      ON CONFLICT(item_id,name) DO UPDATE SET credential_revision=excluded.credential_revision,sealed=excluded.sealed`,
                                args: [entry.id, input.variable, revision, sealed],
                            })
                        } else {
                            if (!exists) throw new DesktopHttpError(404, 'This program credential is no longer saved.')
                            await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_program_credentials WHERE item_id=? AND name=?', args: [entry.id, input.variable] })
                        }
                        await tx.execute({ sql: 'UPDATE desktop_vault_mcp_programs SET revision=? WHERE id=?', args: [revision, entry.id] })
                    } else if (input.operation === 'replace-server-bearer' || input.operation === 'replace-server-header') {
                        if (!('kind' in entry) || entry.kind !== 'mcp') throw new DesktopHttpError(400, 'This entry is not an HTTPS MCP server.')
                        const sealed = await sealServerCredential(entry.id, entry.url, revision, input)
                        await tx.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET revision=?,credential_revision=?,sealed=?,credential_header=? WHERE id=?', args: [revision, revision, sealed, 'header' in input ? input.header.name : null, entry.id] })
                    } else if (input.operation === 'replace') {
                        if ('kind' in entry) throw new DesktopHttpError(400, 'This entry is not a standalone secret.')
                        const sealed = await seal(entry.id, entry.variable, revision, input.value)
                        await tx.execute({ sql: 'UPDATE desktop_vault_secrets SET revision=?,value_revision=?,sealed=? WHERE id=?', args: [revision, revision, sealed, entry.id] })
                    } else if ('kind' in entry && entry.kind === 'program') {
                        await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_program_attachments WHERE item_id=?', args: [entry.id] })
                        await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_program_credentials WHERE item_id=?', args: [entry.id] })
                        await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_programs WHERE id=?', args: [entry.id] })
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
