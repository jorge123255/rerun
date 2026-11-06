import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import type { DesktopRuntime } from '../runtime'
import { readDesktopRuntime } from '../runtime'
import { getDesktopRemoteMcpService, watchDesktopMcpOwner } from '../mcp-binding'
import { remoteMcpRuntime } from '../mcp/remote'
import { remoteMcpLifecycle } from '../mcp/lifecycle'
import { watchDesktopSecretAuthority } from '../secret-requests/lifecycle'
import type { SelfMcpAuthority, SelfMcpProbeAdapter } from './adapters'
import { createSelfMcpConfigAdapter } from './config'
import { createSelfMcpSqlStore, selfMcpInvocation } from './sql-store'
import { createSelfMcpService, type SelfMcpService } from './service'
import type { RemoteMcpStore } from '../mcp/store'
import { reconcileSelfMcpProposals } from './decision'
import { selfMcpSourceAcknowledged } from './source'
import type { SelfMcpRunIdentity } from '@rerun/contracts'

const ownerDetail = z.object({ id: z.string(), config: z.object({ enabled: z.boolean(), ephemeral: z.boolean().optional(), selfImprovement: z.object({ enabled: z.boolean() }), tools: z.object({ desktopToolGrants: z.record(z.string(), z.boolean()).optional() }) }) })
const runDetail = z.object({ id: z.string(), agentId: z.string(), sessionId: z.string(), status: z.string() })
type Ports = {
    db: Client
    owner: (localId?: string, engineId?: string) => Promise<{ id: string; engineId: string }>
    engineJson: (path: string, signal: AbortSignal) => Promise<unknown>
    managedNames: (owner: string) => Promise<string[]>
    mutate: <T>(owner: string, name: string, work: () => Promise<T>) => Promise<T>
    shutdownSignal: AbortSignal
    remoteStore: RemoteMcpStore
}

export async function createDesktopSelfMcpBinding(runtime: DesktopRuntime, ports: Ports): Promise<SelfMcpService> {
    const store = createSelfMcpSqlStore(ports.db), config = createSelfMcpConfigAdapter(ports)
    async function processCurrent() {
        ports.shutdownSignal.throwIfAborted()
        const current = await readDesktopRuntime()
        if (current.launchNonce !== runtime.launchNonce || current.dataRoot !== runtime.dataRoot || current.app.origin !== runtime.app.origin || current.engine.origin !== runtime.engine.origin) throw new Error('Rerun restarted; reload this review.')
    }
    const localSession = async (owner: string, identity: SelfMcpRunIdentity) => {
        const rows = (await ports.db.execute({ sql: 'SELECT id FROM desktop_sessions WHERE agent_id=? AND engine_session_id=?', args: [owner, identity.sessionId] })).rows
        if (rows.length !== 1) throw new Error('The source conversation belongs to another coworker')
        return String(rows[0].id)
    }
    const authority: SelfMcpAuthority = {
        async ownerOfEngineId(engineId) { await processCurrent(); return { agentId: (await ports.owner(undefined, engineId)).id } },
        async watch(owner, identity) {
            const ownerCheck = watchDesktopMcpOwner(runtime, owner)
            const sessionId = await localSession(owner, identity)
            const stopCheck = watchDesktopSecretAuthority(runtime, owner, sessionId)
            ownerCheck(); stopCheck()
            return () => { ports.shutdownSignal.throwIfAborted(); ownerCheck(); stopCheck() }
        },
        async currentOwner(owner, identity, expectedEpoch) {
            await processCurrent()
            const check = await authority.watch!(owner, identity)
            const originalSession = await localSession(owner, identity)
            const owned = await ports.owner(owner)
            if (owned.engineId !== identity.engineAgentId) return null
            const signal = AbortSignal.any([ports.shutdownSignal, AbortSignal.timeout(5000)])
            const prefix = `/agents/${encodeURIComponent(identity.engineAgentId)}`
            const [detail, run, session] = await Promise.all([
                ports.engineJson(prefix, signal).then(ownerDetail.parse),
                ports.engineJson(`${prefix}/runs/${encodeURIComponent(identity.runId)}`, signal).then(runDetail.parse),
                ports.engineJson(`${prefix}/sessions/${encodeURIComponent(identity.sessionId)}`, signal).then(value => z.object({ id: z.string(), agentId: z.string() }).parse(value)),
            ])
            const proposal = (await store.list(owner)).find(item => selfMcpInvocation(item.identity) === selfMcpInvocation(identity))
            if (detail.id !== identity.engineAgentId || run.id !== identity.runId || run.agentId !== identity.engineAgentId || run.sessionId !== identity.sessionId || session.id !== identity.sessionId || session.agentId !== identity.engineAgentId || !['running', 'done'].includes(run.status)) return null
            if (proposal) {
                if (expectedEpoch && expectedEpoch !== proposal.launchEpoch || proposal.launchEpoch !== runtime.launchNonce && run.status !== 'done') return null
                const [tools, messages] = await Promise.all([
                    ports.engineJson(`${prefix}/runs/${encodeURIComponent(identity.runId)}/tools`, signal),
                    ports.engineJson(`${prefix}/sessions/${encodeURIComponent(identity.sessionId)}/messages`, signal),
                ])
                if (!selfMcpSourceAcknowledged(proposal, tools, messages)) return null
            } else if (run.status !== 'running' || expectedEpoch && expectedEpoch !== runtime.launchNonce) return null
            const finalOwner = await ports.owner(owner)
            if (finalOwner.engineId !== identity.engineAgentId || await localSession(owner, identity) !== originalSession) return null
            check(); await processCurrent(); check()
            const grants = detail.config.tools.desktopToolGrants
            return { agentId: owner, engineAgentId: identity.engineAgentId, launchEpoch: proposal?.launchEpoch ?? runtime.launchNonce,
                enabled: detail.config.enabled && !detail.config.ephemeral, deleting: false, selfImprovementEnabled: detail.config.selfImprovement.enabled,
                selfMcpGranted: grants?.selfMcpRegister === true, localMcpStdioGranted: grants?.localMcpStdio === true, remoteMcpGranted: grants?.mcp === true }
        },
    }
    const probe: SelfMcpProbeAdapter = {
        transports: ['http', 'sse', 'stdio'],
        async probe(owner, server, context) {
            await context.assertCurrent()
            if (server.transport !== 'http' || config.requirements!(server).length) return { ok: false, needsCredentials: false, needsPermission: true, credentialsRejected: false, error: 'This configuration is not ready to connect.' }
            let needsCredentials = false
            const temporary = { ...ports.remoteStore, lifecycle: remoteMcpLifecycle(), read: async () => ({ id: 'review-only', name: server.name, transport: 'http' as const, url: server.url!, revision: 'review-only', bearer: '' }), readOAuth: async () => null }
            const network: typeof fetch = async (input, init) => {
                await context.assertCurrent()
                const response = await fetch(input, { ...init, signal: AbortSignal.any([context.signal, ...(init?.signal ? [init.signal] : [])]) })
                if (response.status === 401 || response.status === 403) needsCredentials = true
                return response
            }
            const reader = remoteMcpRuntime(temporary, async () => { await context.assertCurrent(); return { enabled: true, granted: true } }, network)
            try { const result = await reader.probe(owner, server.name, 'review-only', context.signal); await context.assertCurrent(); return { ok: true, toolNames: 'tools' in result && result.tools ? result.tools.map(tool => tool.name) : [] } }
            catch { context.signal.throwIfAborted(); return { ok: false, needsCredentials, needsPermission: false, credentialsRejected: false, error: 'The connection could not be verified.' } }
            finally { reader.disconnect(owner, server.name) }
        },
    }
    const deps = { store, config, authority, probe }
    // Only old-process claims may recover automatically. An active decision in this process
    // must never be reset by a simultaneous list/review request.
    const owners = (await ports.db.execute('SELECT DISTINCT owner FROM desktop_self_mcp_proposals')).rows
    for (const { owner } of owners) await reconcileSelfMcpProposals({ ...deps, now: () => new Date().toISOString(), newId: () => crypto.randomUUID() }, String(owner), { includeClaimed: true })
    const service = createSelfMcpService(deps)
    const manage = async (owner: string) => { await processCurrent(); await ports.owner(owner); await processCurrent() }
    return {
        propose: service.propose,
        list: async owner => { await manage(owner); return service.list(owner) },
        review: async (owner, proposal) => { await manage(owner); return service.review(owner, proposal) },
        decide: async (owner, request, signal) => { await manage(owner); return service.decide(owner, request, signal) },
        dismiss: async (owner, proposal, revision) => { await manage(owner); return service.dismiss(owner, proposal, revision) },
    }
}

export async function desktopSelfMcpService(runtime: DesktopRuntime) {
    return (await getDesktopRemoteMcpService(runtime)).selfMcp
}
