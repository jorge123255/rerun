import 'server-only'
import { z } from 'zod'
import { authenticateDesktopEngineRequest, authenticateDesktopRequest, DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { remoteMcpApi } from './mcp/api'
import { abortable, boundedText, remoteMcpRuntime } from './mcp/remote'
import { remoteMcpSchema, remoteMcpStore } from './mcp/store'
import { desktopMcpBridge, desktopMcpBridgeRequest, type McpRunIdentity } from './mcp/bridge'

const authority = z.object({ id: z.string(), config: z.object({ enabled: z.boolean(), tools: z.object({ desktopToolGrants: z.record(z.string(), z.boolean()).optional() }) }) })
const session = z.object({ id: z.string(), agentId: z.string() })
const run = z.object({ id: z.string(), agentId: z.string(), sessionId: z.string(), status: z.string() })
const SERVICE_KEY = Symbol.for('rerun.desktop.remote-mcp.services.v1')
type Service = Awaited<ReturnType<typeof createService>>
type RegistryEntry = { service?: Promise<Service>; pendingOwners: Map<string, number>; generations: Map<string, number>; closed: boolean }
const registry = () => {
    const globals = globalThis as unknown as Record<symbol, Map<string, RegistryEntry>>
    return globals[SERVICE_KEY] ??= new Map()
}
const keyOf = (runtime: DesktopRuntime) => JSON.stringify([runtime.dataRoot, runtime.launchNonce, runtime.engine.origin, runtime.app.origin])
const entryOf = (runtime: DesktopRuntime) => {
    const services = registry(), key = keyOf(runtime)
    let entry = services.get(key)
    if (!entry) { entry = { pendingOwners: new Map(), generations: new Map(), closed: false }; services.set(key, entry) }
    return entry
}
const masterKey = () => {
    const value = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Desktop credential storage is unavailable')
    return Buffer.from(value, 'hex')
}

async function createService(runtime: DesktopRuntime, entry: RegistryEntry) {
    masterKey()
    const db = await openDesktopDatabase(runtime.dataRoot)
    await db.executeMultiple(remoteMcpSchema)
    const store = remoteMcpStore(db, masterKey)
    async function localOwner(localId?: string, engineId?: string) {
        const result = await db.execute({ sql: `SELECT a.id,a.engine_agent_id FROM desktop_agents a
            WHERE a.workspace_id=1 AND ${localId ? 'a.id' : 'a.engine_agent_id'}=?
            AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)`, args: [localId ?? engineId!] })
        if (result.rows.length !== 1) throw new Error('Coworker is unavailable')
        return { id: String(result.rows[0].id), engineId: String(result.rows[0].engine_agent_id) }
    }
    async function engineJson(path: string, signal: AbortSignal) {
        signal.throwIfAborted()
        const response = await fetch(`${runtime.engine.origin}${path}`, { headers: { Authorization: `Bearer ${runtime.engine.apiKey}` }, signal, cache: 'no-store', redirect: 'error' })
        if (!response.ok) { await abortable(response.body?.cancel() ?? Promise.resolve(), signal).catch(() => {}); throw new Error('Coworker authority is unavailable') }
        return JSON.parse(await boundedText(response, signal))
    }
    async function access(localId: string) {
        const generation = entry.generations.get(localId) ?? 0
        const current = () => { if (entry.closed || entry.pendingOwners.get(localId) || (entry.generations.get(localId) ?? 0) !== generation) throw new Error('Coworker permission is changing') }
        current()
        const signal = AbortSignal.timeout(5_000)
        const owner = await abortable(localOwner(localId), signal)
        const detail = authority.parse(await engineJson(`/agents/${encodeURIComponent(owner.engineId)}`, signal))
        const final = await abortable(localOwner(localId), signal)
        current()
        if (detail.id !== owner.engineId || final.engineId !== owner.engineId) throw new Error('Coworker identity changed')
        return { enabled: detail.config.enabled, granted: detail.config.tools.desktopToolGrants?.mcp === true }
    }
    const remote = remoteMcpRuntime(store, access)
    const authorize = async (identity: McpRunIdentity, stop: AbortSignal) => {
        const signal = AbortSignal.any([stop, AbortSignal.timeout(5_000)])
        const owner = await abortable(localOwner(undefined, identity.engineAgentId), signal)
        const permission = await abortable(access(owner.id), signal)
        if (!permission.enabled || !permission.granted) throw new Error('MCP is disabled for this coworker')
        const prefix = `/agents/${encodeURIComponent(identity.engineAgentId)}`
        const [currentSession, currentRun] = await Promise.all([
            engineJson(`${prefix}/sessions/${encodeURIComponent(identity.sessionId)}`, signal).then(value => session.parse(value)),
            engineJson(`${prefix}/runs/${encodeURIComponent(identity.runId)}`, signal).then(value => run.parse(value)),
        ])
        if (currentSession.id !== identity.sessionId || currentSession.agentId !== identity.engineAgentId || currentRun.id !== identity.runId
            || currentRun.agentId !== identity.engineAgentId || currentRun.sessionId !== identity.sessionId || currentRun.status !== 'running') throw new Error('MCP request does not belong to this active run')
        const final = await abortable(localOwner(owner.id), signal)
        if (final.engineId !== identity.engineAgentId) throw new Error('Coworker identity changed')
        signal.throwIfAborted()
        return owner.id
    }
    const bridge = desktopMcpBridge(store, remote, authorize)
    return { store, runtime: remote, bridge, api: remoteMcpApi(store, remote, access) }
}

/** Next may bundle each route independently. This process-wide promise is the single authority. */
export function getDesktopRemoteMcpService(runtime: DesktopRuntime): Promise<Service> {
    const entry = entryOf(runtime)
    if (entry.closed) return Promise.reject(new Error('MCP is stopped'))
    if (!entry.service) {
        const service = createService(runtime, entry)
        entry.service = service
        void service.catch(() => { if (entry.service === service) entry.service = undefined })
    }
    return entry.service
}

export async function withDesktopMcpOwnerTransition<T>(runtime: DesktopRuntime, localAgentId: string, write: () => Promise<T>): Promise<T> {
    const entry = entryOf(runtime)
    // Reserve synchronously, including when initialization is pending or has not started. A
    // legacy coworker mutation needs no new key/store; a concurrently created service sees it.
    entry.pendingOwners.set(localAgentId, (entry.pendingOwners.get(localAgentId) ?? 0) + 1)
    entry.generations.set(localAgentId, (entry.generations.get(localAgentId) ?? 0) + 1)
    try {
        // A failed initializer published no runtime. It must never prevent disabling or
        // deleting a coworker; the global reservation still excludes concurrent admission.
        const service = entry.service ? await entry.service.catch(() => undefined) : undefined
        if (!service) return await write()
        return await service.store.lifecycle.transitionOwner(localAgentId, async () => { service.bridge.invalidateOwner(localAgentId); return write() })
    } finally {
        const count = (entry.pendingOwners.get(localAgentId) ?? 1) - 1
        if (count) entry.pendingOwners.set(localAgentId, count); else entry.pendingOwners.delete(localAgentId)
        entry.generations.set(localAgentId, (entry.generations.get(localAgentId) ?? 0) + 1)
    }
}
export async function shutdownDesktopRemoteMcp(runtime: DesktopRuntime) {
    const entry = entryOf(runtime)
    entry.closed = true
    if (entry.service) (await entry.service).bridge.shutdown()
}

export async function handleDesktopMcpManagement(request: Request, agentId: string): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        return await (await getDesktopRemoteMcpService(runtime)).api(request, agentId)
    } catch (error) {
        return Response.json({ error: 'MCP configuration is unavailable.' }, { status: error instanceof DesktopHttpError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
    }
}

export async function handleDesktopMcpBridge(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
        const body = desktopMcpBridgeRequest.parse(JSON.parse(await boundedText(new Response(request.body), signal, 96_000)))
        if (body.action === 'shutdown') { await shutdownDesktopRemoteMcp(runtime); return Response.json({ stopped: true }, { headers: { 'Cache-Control': 'no-store' } }) }
        const service = await getDesktopRemoteMcpService(runtime)
        const result = await service.bridge.handle(body, request.signal)
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
        return Response.json({ error: 'MCP request failed. Check this coworker’s permission and connection.' }, { status: error instanceof DesktopHttpError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } })
    }
}
