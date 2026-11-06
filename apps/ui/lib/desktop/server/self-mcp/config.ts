import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { desktopMcpSecretReferencePublicIssue, selfMcpCanonicalInput } from '@rerun/contracts'
import { endpoint } from '../mcp/model'
import { stdioInput } from '../mcp-stdio/store'
import type { SelfMcpApplyIdentity, SelfMcpApplyReceipt, SelfMcpConfigAdapter, SelfMcpServerCandidate } from './adapters'
import { selfMcpFingerprint } from './fingerprint'
import { adoptDesktopMcpReferences } from '../mcp-secret-references/transaction'

const activeEffects = new WeakMap<Client, Set<string>>()

export const selfMcpEffectIdentity = (identity: SelfMcpApplyIdentity) => JSON.stringify([
    identity.launchEpoch, identity.decision.agentId, identity.decision.id, identity.decision.proposalId,
    identity.decision.proposalRevision, identity.decision.configRevision, identity.decision.identity,
    identity.decision.fingerprint, identity.decision.outcome,
])
export function selfMcpConfigurationRequirements(server: SelfMcpServerCandidate): string[] {
    const requirements: string[] = []
    const issue = desktopMcpSecretReferencePublicIssue(server)
    if (issue) requirements.push(issue)
    if (server.transport === 'stdio') {
        if (/^(?:sh|bash|zsh|fish|csh|tcsh|ksh|env|sudo|npx|npm|pnpm|yarn|bunx|uvx|uv|pip|pip3|pipx|osascript|open|launchctl)$/.test(server.command?.split('/').pop() ?? '')) requirements.push('Shells and package runners are not supported as local MCP programs. Choose the installed server executable.')
        if (!stdioInput.safeParse({ name: server.name, executable: server.command, args: server.args }).success) requirements.push('Local programs need the absolute path of an installed executable. This review does not install packages or run shell commands.')
    } else {
        if (server.command || server.args.length) requirements.push('Remote MCP connections cannot use a command or local arguments. Review the full proposal before adding this connection.')
        try { endpoint(server.url ?? '') } catch { requirements.push('Remote connections need an HTTPS address without credentials, query parameters or fragments.') }
    }
    return requirements
}

export function createSelfMcpConfigAdapter(ports: {
    db: Client
    origin?: string
    managedNames: (owner: string) => Promise<string[]>
    /** Drains existing transports and holds their canonical mutation fences. */
    mutate: <T>(owner: string, name: string, write: () => Promise<T>) => Promise<T>
}): SelfMcpConfigAdapter {
    const { db } = ports
    let active = activeEffects.get(db)
    if (!active) { active = new Set(); activeEffects.set(db, active) }
    const activeKey = (owner: string, decisionId: string) => JSON.stringify([owner, decisionId])
    const revision = async (owner: string, executor: Client | Transaction = db) => Number((await executor.execute({ sql: 'SELECT revision FROM desktop_self_mcp_config_revisions WHERE owner=?', args: [owner] })).rows[0]?.revision ?? 0)
    const find = async (owner: string, name: string): Promise<SelfMcpServerCandidate | null> => {
        const [remote, local] = await Promise.all([
            db.execute({ sql: 'SELECT transport,name,url,revision FROM desktop_remote_mcp WHERE agent_id=? AND name=?', args: [owner, name] }),
            db.execute({ sql: 'SELECT name,executable,args,revision FROM desktop_mcp_stdio WHERE owner=? AND name=?', args: [owner, name] }),
        ])
        if (remote.rows.length && local.rows.length) throw new Error('This MCP name belongs to more than one connection. Resolve the conflict in settings.')
        const row = remote.rows[0] ?? local.rows[0]
        if (!row) return null
        const head = (await db.execute({ sql: 'SELECT config_revision,public_json FROM desktop_mcp_secret_reference_heads WHERE agent_id=? AND server_name=?', args: [owner, name] })).rows[0]
        if (head?.config_revision === row.revision) {
            const config = JSON.parse(String(head.public_json))
            return { name: config.name, transport: config.transport, ...(config.url ? { url: config.url } : {}), ...(config.command ? { command: config.command } : {}), args: config.args, env: config.env, headers: config.headers }
        }
        return remote.rows.length ? { name: String(row.name), transport: String(row.transport) as 'http' | 'sse', url: String(row.url), args: [], env: {}, headers: {} }
            : { name: String(row.name), transport: 'stdio', command: String(row.executable), args: JSON.parse(String(row.args)), env: {}, headers: {} }
    }
    return {
        requirements: selfMcpConfigurationRequirements, revision, managedNames: ports.managedNames, find,
        async reviewRequirements(owner, server) {
            const [remote, local, oauth] = await Promise.all([
                db.execute({ sql: 'SELECT bearer FROM desktop_remote_mcp WHERE agent_id=? AND name=?', args: [owner, server.name] }),
                db.execute({ sql: 'SELECT name FROM desktop_mcp_stdio WHERE owner=? AND name=?', args: [owner, server.name] }),
                db.execute({ sql: 'SELECT 1 FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?', args: [owner, server.name] }),
            ])
            const requirements: string[] = []
            if (remote.rows.length && server.transport === 'stdio' || local.rows.length && server.transport !== 'stdio') requirements.push('This name uses another transport. Edit the connection in MCP settings before replacing it.')
            if (remote.rows[0]?.bearer || oauth.rows.length) requirements.push('This connection already has credentials. Edit it in MCP settings to preserve its authentication.')
            return requirements
        },
        async hasServer(owner, server) {
            const existing = await find(owner, server.name)
            const authentication = (await db.execute({ sql: 'SELECT 1 FROM desktop_remote_mcp WHERE agent_id=? AND name=? AND bearer IS NOT NULL UNION ALL SELECT 1 FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?', args: [owner, server.name, owner, server.name] })).rows
            return !authentication.length && !!existing && selfMcpCanonicalInput(existing) === selfMcpCanonicalInput(server)
        },
        async connectivity(owner, server) {
            const rows = (await db.execute({ sql: 'SELECT r.status,r.secret_version,c.version FROM desktop_mcp_secret_references r LEFT JOIN desktop_secret_credentials c ON c.agent_id=r.agent_id AND c.key=r.secret_name WHERE r.agent_id=? AND r.server_name=?', args: [owner, server.name] })).rows
            return rows.some(row => row.status !== 'bound' || row.secret_version !== row.version) ? 'needs_credentials' : 'unverified'
        },
        async recover(owner, identity) {
            if (active!.has(activeKey(owner, identity.decision.id))) return { state: 'uncertain' }
            const row = (await db.execute({ sql: 'SELECT identity,receipt FROM desktop_self_mcp_effects WHERE owner=? AND decision_id=?', args: [owner, identity.decision.id] })).rows[0]
            if (!row) return { state: 'not_applied' }
            if (row.identity !== selfMcpEffectIdentity(identity)) throw new Error('MCP effect belongs to another decision')
            return { state: 'applied', receipt: JSON.parse(String(row.receipt)) as SelfMcpApplyReceipt }
        },
        async apply(owner, server, identity, context, result) {
            if (identity.decision.agentId !== owner || identity.decision.outcome.kind !== 'approved') throw new Error('MCP decision owner changed')
            if (selfMcpConfigurationRequirements(server).length) throw new Error('This configuration still has requirements')
            if (![selfMcpFingerprint(server), selfMcpFingerprint({ ...server, transport: undefined })].includes(identity.decision.fingerprint)) throw new Error('The configuration does not match the reviewed proposal')
            const key = activeKey(owner, identity.decision.id)
            if (active!.has(key)) throw new Error('This MCP decision is already being applied')
            active!.add(key)
            try {
            await context.assertCurrent()
            return await ports.mutate(owner, server.name, async () => {
                await context.assertCurrent()
                const tx = await db.transaction('write')
                try {
                    const previous = (await tx.execute({ sql: 'SELECT identity,receipt FROM desktop_self_mcp_effects WHERE owner=? AND decision_id=?', args: [owner, identity.decision.id] })).rows[0]
                    if (previous) {
                        if (previous.identity !== selfMcpEffectIdentity(identity)) throw new Error('MCP effect belongs to another decision')
                        context.assertCommit?.(); context.signal.throwIfAborted(); await tx.commit()
                        return JSON.parse(String(previous.receipt)) as SelfMcpApplyReceipt
                    }
                    if (await revision(owner, tx) !== identity.decision.configRevision) throw new Error('The MCP configuration changed. Review it again.')
                    const remote = (await tx.execute({ sql: 'SELECT * FROM desktop_remote_mcp WHERE agent_id=? AND name=?', args: [owner, server.name] })).rows[0]
                    const local = (await tx.execute({ sql: 'SELECT * FROM desktop_mcp_stdio WHERE owner=? AND name=?', args: [owner, server.name] })).rows[0]
                    if (remote && server.transport === 'stdio' || local && server.transport !== 'stdio') throw new Error('This name uses another transport. Edit the connection in settings.')
                    const authentication = (await tx.execute({ sql: 'SELECT 1 FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?', args: [owner, server.name] })).rows[0]
                    if (remote?.bearer || authentication) throw new Error('This connection already has credentials. Edit it in settings to preserve its authentication.')
                    const canonicalRevision = randomUUID()
                    if (server.transport === 'stdio') {
                        const count = Number((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_mcp_stdio WHERE owner=?', args: [owner] })).rows[0].n)
                        if (!local && count >= 16) throw new Error('Too many local connections')
                        await tx.execute({ sql: 'INSERT INTO desktop_mcp_stdio(owner,name,executable,args,revision) VALUES(?,?,?,?,?) ON CONFLICT(owner,name) DO UPDATE SET executable=excluded.executable,args=excluded.args,revision=excluded.revision', args: [owner, server.name, server.command!, JSON.stringify(server.args), canonicalRevision] })
                    } else {
                        const count = Number((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_remote_mcp WHERE agent_id=?', args: [owner] })).rows[0].n)
                        if (!remote && count >= 16) throw new Error('Too many remote connections')
                        await tx.execute({ sql: 'INSERT INTO desktop_remote_mcp(id,transport,agent_id,name,url,revision,bearer) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(agent_id,name) DO UPDATE SET transport=excluded.transport,url=excluded.url,revision=excluded.revision,bearer=NULL', args: [remote?.id ?? randomUUID(), server.transport, owner, server.name, endpoint(server.url!), canonicalRevision] })
                    }
                    const reference = await adoptDesktopMcpReferences(tx, { agentId: owner, serverName: server.name, configRevision: canonicalRevision, origin: ports.origin ?? 'desktop-workspace-1', config: server, check: () => { context.assertCommit?.(); context.signal.throwIfAborted() } })
                    const outcome = reference.pending.length ? { outcome: 'applied_pending_credentials' as const, detail: 'The reviewed server was saved with pending credential references. Add those credentials and review the bindings in MCP settings before connecting.' } : result
                    const saved: SelfMcpApplyReceipt = { ...identity, ...outcome, configRevision: await revision(owner, tx) }
                    if (saved.configRevision <= identity.decision.configRevision) throw new Error('The MCP configuration revision did not advance')
                    await tx.execute({ sql: 'INSERT INTO desktop_self_mcp_effects(owner,decision_id,identity,receipt) VALUES(?,?,?,?)', args: [owner, identity.decision.id, selfMcpEffectIdentity(identity), JSON.stringify(saved)] })
                    await context.assertCurrent(); context.assertCommit?.(); context.signal.throwIfAborted()
                    await tx.commit()
                    return saved
                } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
            })
            } finally { active!.delete(key) }
        },
    }
}
