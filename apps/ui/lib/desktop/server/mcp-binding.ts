import { assertDesktopWorkspaceAdmission } from './workspace-admission'
import { assignedVaultMcpPrograms, vaultProgramMaterials } from './vault/mcp-programs'
import { desktopVaultMcpRuntime } from './vault/mcp-runtime'
import { createDesktopSecretCrypto } from './secret-requests/crypto'
import { shutdownDesktopForeman } from './foreman/binding'
import { shutdownDesktopForemanVoice } from './foreman-voice/binding'
import { canonicalDesktopEngineRoot, desktopEngineParts } from './runtime'
import 'server-only'
import { createCanonicalMcpSecretReferences } from './mcp-secret-references/binding'
import type { DesktopMcpMaterialSource } from './mcp-secret-references/lease'
import { z } from 'zod'
import { createDesktopSelfMcpBinding } from './self-mcp/binding'
import { desktopRerunToolCatalog, desktopCodexToolCatalog } from '@rerun/contracts'
import { serviceStore } from './services/store'
import { bindDesktopServiceSkillOwners, desktopServiceSkillRestartScope } from './service-skills/authority'
import { localServiceLifecycle, type ServiceAuthority } from './services/lifecycle'
import { serviceApi } from './services/api'
import { serviceEngineBridge } from './services/bridge'
import { createCanonicalServiceOAuth } from './services/oauth/binding'
import { createCanonicalServiceTransports } from './services/transports/binding'
import { canonicalServiceAccounts } from './services/accounts/canonical'
import { createDesktopSseBinding } from './mcp-sse/binding'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { stdioStore } from './mcp-stdio/store'
import { stdioRuntime, type StdioAuthority } from './mcp-stdio/runtime'
import { stdioApi } from './mcp-stdio/api'
import { stdioEngineBridge } from './mcp-stdio/bridge'
import { nativeWritebackService } from './native-writeback/service'
import { nativeWritebackApi } from './native-writeback/api'
import { authenticateDesktopEngineRequest, authenticateDesktopRequest, DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { remoteMcpApi } from './mcp/api'
import { abortable, boundedText, remoteMcpRuntime } from './mcp/remote'
import { remoteMcpStore, bindRemoteTransportDrain } from './mcp/store'
import { initializeDesktopMcp } from './mcp/schema'
import { loopbackMcpOAuth } from './mcp/oauth-loopback'
import { createMcpOAuthAttempts } from './mcp/oauth-attempt'
import { bindTrustedMcpDeviceMethodReview } from './mcp-device-approval/binding'
import { createDesktopMcpBrowserApprovals } from './mcp-sign-in/browser-approval'
import { loopbackOAuthApi } from './mcp/oauth-api'
import { desktopMcpBridge, desktopMcpBridgeRequest, type McpRunIdentity } from './mcp/bridge'

const authority = z.object({ id: z.string(), config: z.object({ enabled: z.boolean(), tools: z.object({ filesystem: z.boolean().optional(), shared: z.boolean().optional(), desktopToolGrants: z.record(z.string(), z.boolean()).optional(), desktopCodexGrants: z.record(z.string(), z.boolean()).optional() }) }) })
const session = z.object({ id: z.string(), agentId: z.string() })
const run = z.object({ id: z.string(), agentId: z.string(), sessionId: z.string(), status: z.string() })
const SERVICE_KEY = Symbol.for('rerun.desktop.remote-mcp.services.v1')
type Service = Awaited<ReturnType<typeof createService>>
type RegistryEntry = { service?: Promise<Service>; pendingOwners: Map<string, number>; generations: Map<string, number>; closed: boolean; shutdown: AbortController }
const registry = () => {
    const globals = globalThis as unknown as Record<symbol, Map<string, RegistryEntry>>
    return globals[SERVICE_KEY] ??= new Map()
}
const keyOf = (runtime: DesktopRuntime) => JSON.stringify([runtime.dataRoot, runtime.launchNonce, runtime.engine.origin, runtime.app.origin])
const entryOf = (runtime: DesktopRuntime) => {
    const services = registry(), key = keyOf(runtime)
    let entry = services.get(key)
    if (!entry) { entry = { pendingOwners: new Map(), generations: new Map(), closed: false, shutdown: new AbortController() }; services.set(key, entry) }
    return entry
}
const masterKey = () => {
    const value = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Desktop credential storage is unavailable')
    return Buffer.from(value, 'hex')
}

async function createService(runtime: DesktopRuntime, entry: RegistryEntry) {
    masterKey()
    bindDesktopServiceSkillOwners(runtime)
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopMcp(db)
    entry.shutdown.signal.throwIfAborted()
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
    async function access(localId: string, grant: 'mcp' | 'privateFileWrite' | 'localMcpStdio' | 'nativeWriteback' | 'services' | 'webSearch' | 'sharedFilesWrite' = 'mcp') {
        const generation = entry.generations.get(localId) ?? 0
        const current = () => { if (entry.closed || entry.pendingOwners.get(localId) || (entry.generations.get(localId) ?? 0) !== generation) throw new Error('Coworker permission is changing') }
        current()
        const signal = AbortSignal.any([entry.shutdown.signal, AbortSignal.timeout(5_000)])
        const owner = await abortable(localOwner(localId), signal)
        const detail = authority.parse(await engineJson(`/agents/${encodeURIComponent(owner.engineId)}`, signal))
        const final = await abortable(localOwner(localId), signal)
        current()
        if (detail.id !== owner.engineId || final.engineId !== owner.engineId) throw new Error('Coworker identity changed')
        signal.throwIfAborted()
        return { enabled: detail.config.enabled, granted: detail.config.tools.desktopToolGrants?.[grant] === true && (grant !== 'privateFileWrite' || detail.config.tools.filesystem === true) && (grant !== 'sharedFilesWrite' || detail.config.tools.shared !== false) }
    }
    const oauth = loopbackMcpOAuth(store, access, undefined, store, createMcpOAuthAttempts(db))
    const material: DesktopMcpMaterialSource = (...args) => references.material(...args)
    const remote = remoteMcpRuntime(store, access, fetch, oauth.credential, material)
    const authorizeRun = async (identity: McpRunIdentity, stop: AbortSignal, grant: 'mcp' | 'privateFileWrite' | 'localMcpStdio' | 'nativeWriteback' | 'services' | 'webSearch' | 'sharedFilesWrite' = 'mcp') => {
        const signal = AbortSignal.any([stop, entry.shutdown.signal, AbortSignal.timeout(5_000)])
        const owner = await abortable(localOwner(undefined, identity.engineAgentId), signal)
        const generation = entry.generations.get(owner.id) ?? 0
        const permission = await abortable(access(owner.id, grant), signal)
        if (!permission.enabled || !permission.granted) throw new Error('Tool permission is disabled for this coworker')
        const prefix = `/agents/${encodeURIComponent(identity.engineAgentId)}`
        const [currentSession, currentRun] = await Promise.all([
            engineJson(`${prefix}/sessions/${encodeURIComponent(identity.sessionId)}`, signal).then(value => session.parse(value)),
            engineJson(`${prefix}/runs/${encodeURIComponent(identity.runId)}`, signal).then(value => run.parse(value)),
        ])
        if (currentSession.id !== identity.sessionId || currentSession.agentId !== identity.engineAgentId || currentRun.id !== identity.runId
            || currentRun.agentId !== identity.engineAgentId || currentRun.sessionId !== identity.sessionId || currentRun.status !== 'running') throw new Error('MCP request does not belong to this active run')
        const final = await abortable(localOwner(owner.id), signal)
        if (final.engineId !== identity.engineAgentId) throw new Error('Coworker identity changed')
        const finalPermission = await abortable(access(owner.id, grant), signal)
        if (!finalPermission.enabled || !finalPermission.granted || entry.closed || entry.pendingOwners.get(owner.id) || (entry.generations.get(owner.id) ?? 0) !== generation) throw new Error('Coworker permission changed')
        signal.throwIfAborted()
        return owner.id
    }
    async function currentOwner(localId: string, stop: AbortSignal) {
        const generation = entry.generations.get(localId) ?? 0
        const check = () => {
            stop.throwIfAborted()
            if (entry.closed || entry.pendingOwners.get(localId) || (entry.generations.get(localId) ?? 0) !== generation) throw new Error('Coworker permission is changing')
        }
        check()
        const owner = await abortable(localOwner(localId), stop)
        if (!/^[A-Za-z0-9_-]+$/.test(owner.engineId)) throw new Error('Invalid coworker identity')
        const detail = authority.parse(await engineJson(`/agents/${encodeURIComponent(owner.engineId)}`, stop))
        const root = await realpath(/* turbopackIgnore: true */ runtime.dataRoot)
        const engineRoot = await canonicalDesktopEngineRoot(runtime)
        const workspaceRoot = join(/* turbopackIgnore: true */ engineRoot, 'agents', owner.engineId, 'workspace')
        // Every ancestor must be canonical, so a swapped agent directory cannot alias a sibling.
        for (const path of [root, ...desktopEngineParts(runtime).map((_, i, parts) => join(/* turbopackIgnore: true */ root, ...parts.slice(0, i + 1))), join(/* turbopackIgnore: true */ engineRoot, 'agents'), join(/* turbopackIgnore: true */ engineRoot, 'agents', owner.engineId), workspaceRoot]) {
            const stat = await lstat(/* turbopackIgnore: true */ path)
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(/* turbopackIgnore: true */ path) !== path) throw new Error('Coworker workspace unavailable')
        }
        const final = await abortable(localOwner(localId), stop)
        check()
        if (detail.id !== owner.engineId || final.engineId !== owner.engineId) throw new Error('Coworker identity changed')
        return { owner, config: detail.config, workspaceRoot, check }
    }
    async function historicalOwner(identity: McpRunIdentity, stop: AbortSignal) {
        const owner = await abortable(localOwner(undefined, identity.engineAgentId), stop)
        const current = await currentOwner(owner.id, stop)
        const prefix = `/agents/${encodeURIComponent(identity.engineAgentId)}`
        const [savedSession, savedRun] = await Promise.all([
            engineJson(`${prefix}/sessions/${encodeURIComponent(identity.sessionId)}`, stop).then(value => session.parse(value)),
            engineJson(`${prefix}/runs/${encodeURIComponent(identity.runId)}`, stop).then(value => run.parse(value)),
        ])
        current.check()
        if (current.owner.engineId !== identity.engineAgentId || savedSession.id !== identity.sessionId || savedSession.agentId !== identity.engineAgentId || savedRun.id !== identity.runId || savedRun.agentId !== identity.engineAgentId || savedRun.sessionId !== identity.sessionId) throw new Error('Run belongs to another coworker')
        return { ...current, run: savedRun }
    }
    const localStore = stdioStore(db)
    const localAuthority: StdioAuthority = async (owner, action, identity, signal) => {
        const stop = AbortSignal.any([signal, entry.shutdown.signal])
        const current = identity ? await historicalOwner(identity, stop) : await currentOwner(owner, stop)
        if (current.owner.id !== owner) throw new Error('Local MCP owner changed')
        if (action === 'use') {
            if (!current.config.enabled || current.config.tools.desktopToolGrants?.localMcpStdio !== true) throw new Error('Local MCP permission is off')
            if (identity && (!('run' in current) || run.parse(current.run).status !== 'running')) throw new Error('Run is no longer active')
        }
        current.check()
        return { cwd: current.workspaceRoot }
    }
    const localRuntime = stdioRuntime(localStore, localAuthority, undefined, material,
        owner => assignedVaultMcpPrograms(db, owner), vaultProgramMaterials(db, createDesktopSecretCrypto(masterKey), runtime.workspaceId))
    const localBridge = stdioEngineBridge(localRuntime, async (identity, signal, action) => {
        if (action !== 'release') return authorizeRun(identity, signal, 'localMcpStdio')
        return (await historicalOwner(identity, signal)).owner.id
    })
    const installedServices = serviceStore(db, masterKey)
    const serviceAuthority: ServiceAuthority = async (owner, action, identity, signal) => {
        const stop = AbortSignal.any([signal, entry.shutdown.signal])
        const current = identity ? await historicalOwner(identity, stop) : await currentOwner(owner, stop)
        if (current.owner.id !== owner) throw new Error('Service owner changed')
        const enabled = current.config.enabled, granted = current.config.tools.desktopToolGrants?.services === true
        if (action === 'use' && (!enabled || !granted || identity && (!('run' in current) || run.parse(current.run).status !== 'running'))) throw new Error('Service permission is off or the run stopped')
        current.check()
        return { engineAgentId: current.owner.engineId, runtime, skillsRoot: join(/* turbopackIgnore: true */ current.workspaceRoot, '..', 'skills'), enabled, granted, check: current.check }
    }
    const services = localServiceLifecycle(installedServices, serviceAuthority, async (owner, installationId, names, signal) => {
        signal.throwIfAborted()
        const reserved = new Set([...desktopRerunToolCatalog, ...desktopCodexToolCatalog].flatMap(entry => entry.tools))
        const [remoteRows, localRows, serviceRows] = await Promise.all([store.list(owner), localStore.list(owner), installedServices.list(owner)])
        const prefixes = [...remoteRows.map(row => row.name), ...localRows.map(row => row.name), ...serviceRows.filter(row => row.id !== installationId && row.state !== 'disconnected').map(row => row.plan.serverName)]
        if (new Set(names).size !== names.length || names.some(name => !/^[\w.-]{1,128}$/.test(name) || reserved.has(name) || prefixes.some(prefix => name.startsWith(`${prefix}_`)))) throw new Error('Service tool conflicts with another tool')
        signal.throwIfAborted()
    }, fetch, undefined, (owner, signal) => desktopServiceSkillRestartScope(runtime, owner, signal))
    const servicesBridge = serviceEngineBridge(installedServices, services, async (identity, signal, action) => {
        if (action !== 'release') return authorizeRun(identity, signal, 'services')
        return (await historicalOwner(identity, signal)).owner.id
    }, (owner, identity, signal) => serviceTransports.releaseRun(owner, identity, signal))
    const accounts = await canonicalServiceAccounts(runtime, installedServices, services, masterKey, {
        additionalTransport: (record, run, signal) => serviceTransports?.service(record, run, signal),
        oauthCredential: (record, run, signal) => serviceOAuth.credentialFor(record, run, signal),
        beforeChange: async (owner, id) => { await serviceTransports.beforeChange(owner, id); await serviceOAuth.invalidateAccount(owner, id) },
    })
    const serviceOAuth = createCanonicalServiceOAuth(runtime, installedServices, services, accounts, masterKey, entry.shutdown.signal)
    await serviceOAuth.reconcile()
    const sse = createDesktopSseBinding({
        db, store, key: masterKey, shutdownSignal: entry.shutdown.signal, access, authorizeRun, materials: material,
        manage: async (owner, signal) => (await currentOwner(owner, signal)).check,
        refreshCredential: oauth.credential,
        account: (ref, action, run, signal) => serviceTransports.account(ref, action, run, signal),
        async validateToolNames(owner, names, signal) {
            signal.throwIfAborted()
            const reserved = new Set([...desktopRerunToolCatalog, ...desktopCodexToolCatalog].flatMap(item => item.tools))
            const [localRows, serviceRows] = await Promise.all([localStore.list(owner), installedServices.list(owner)])
            const prefixes = [...localRows.map(row => row.name), ...serviceRows.filter(row => row.state !== 'disconnected').map(row => row.plan.serverName)]
            if (new Set(names).size !== names.length || names.some(name => !/^[\w.-]{1,128}$/.test(name) || reserved.has(name) || prefixes.some(prefix => name.startsWith(`${prefix}_`)))) throw new Error('MCP tool conflicts with another tool')
            signal.throwIfAborted()
        },
    })
    const serviceTransports = createCanonicalServiceTransports(runtime, installedServices, services, masterKey, access, entry.shutdown.signal, () => sse)
    bindRemoteTransportDrain(store, async (owner, name) => {
        const row = await store.read(owner, name)
        if (row.transport === 'sse' && row.id) await sse.dispose(owner, row.id)
    })
    const references = createCanonicalMcpSecretReferences({
        db, key: masterKey, origin: 'desktop-workspace-1', workspaceId: runtime.workspaceId, shutdown: entry.shutdown.signal,
        async owner(id, signal) {
            const current = await currentOwner(id, signal)
            const grants = current.config.tools.desktopToolGrants
            return { agentId: id, enabled: current.config.enabled, deleting: false, selfMcpGranted: grants?.mcp === true || grants?.localMcpStdio === true, localMcpStdioGranted: grants?.localMcpStdio === true, remoteMcpGranted: grants?.mcp === true, check: current.check }
        },
        mutate: (id, name, write) => store.lifecycle.mutate(id, name, () => localRuntime.transitionOwner(id, async () => { await sse.dispose(id); entry.shutdown.signal.throwIfAborted(); return write() })),
        async configuration(id, name) {
            const remote = (await store.list(id)).find(row => row.name === name)
            const local = (await localStore.list(id)).find(row => row.name === name)
            if (!!remote === !!local) throw new Error('MCP server is missing or ambiguous')
            const common = { name, args: [] as string[], headers: {}, env: {}, oauth: false, literalAuthorization: false, preservedLiteralKeys: [] as { field: 'header' | 'env' | 'arg'; key: string }[] }
            if (local) return { revision: local.revision, config: { ...common, transport: 'stdio' as const, command: local.executable, args: local.args } }
            const hasOAuth = (await db.execute({ sql: 'SELECT name FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?', args: [id, name] })).rows.length > 0
            return { revision: remote!.revision, config: { ...common, transport: remote!.transport ?? 'http', url: remote!.url, oauth: hasOAuth, literalAuthorization: remote!.hasBearer, preservedLiteralKeys: remote!.hasBearer ? [{ field: 'header' as const, key: 'Authorization' }] : [] } }
        },
    })
    // Offline reconciliation verifies canonical owned skills without replaying remote work.
    await services.reconcileOwners(entry.shutdown.signal)
    entry.shutdown.signal.throwIfAborted()
    const writeback = nativeWritebackService(db, async (identity, action, signal) => {
        const stop = AbortSignal.any([signal, entry.shutdown.signal])
        const current = await historicalOwner(identity, stop)
        if (action === 'capture' || action === 'apply') {
            const tools = current.config.tools
            if (!current.config.enabled || tools.desktopToolGrants?.nativeWriteback !== true || tools.desktopCodexGrants?.workspaceRead !== true || tools.desktopCodexGrants?.workspaceWrite !== true) throw new Error('Native file review permission is off')
            if (current.run.status === 'cancelled') throw new Error('Cancelled changes are discarded')
        }
        current.check()
        return { owner: current.owner.id, runtime, workspaceRoot: current.workspaceRoot, cancelled: current.run.status === 'cancelled' }
    })
    const selfMcp = await createDesktopSelfMcpBinding(runtime, {
        db, owner: localOwner, engineJson, shutdownSignal: entry.shutdown.signal, remoteStore: store,
        managedNames: async owner => (await installedServices.list(owner)).filter(row => row.state !== 'disconnected').map(row => row.plan.serverName),
        mutate: (owner, name, write) => store.lifecycle.mutate(owner, name, () => localRuntime.transitionOwner(owner, async () => {
            await sse.dispose(owner)
            entry.shutdown.signal.throwIfAborted()
            return write()
        })),
    })
    const vaultMcp = desktopVaultMcpRuntime(db, createDesktopSecretCrypto(masterKey), runtime.workspaceId, access, entry.shutdown.signal, undefined, () => assertDesktopWorkspaceAdmission(runtime))
    const bridge = desktopMcpBridge(store, remote, authorizeRun, {
        async tools(owner, run, signal) {
            return [...await sse.tools(owner, run, signal), ...await vaultMcp.tools(owner, signal)]
        },
        releaseRun: sse.releaseRun,
    })
    const deviceReview = bindTrustedMcpDeviceMethodReview({ runtime, db, key: masterKey, store, shutdown: entry.shutdown.signal })
    entry.shutdown.signal.addEventListener('abort', deviceReview.dispose, { once: true })
    return { store, references, runtime: remote, bridge, vaultOAuth: vaultMcp.oauth, access, authorizeRun, deviceReview, shutdownSignal: entry.shutdown.signal, oauth, oauthApi: loopbackOAuthApi(oauth, access), api: remoteMcpApi(store, remote, access),
        browserApprovals: (scope: Omit<Parameters<typeof createDesktopMcpBrowserApprovals>[3], 'workspaceId'>) =>
            createDesktopMcpBrowserApprovals(db, store, masterKey, { ...scope, workspaceId: String(runtime.workspaceId) }),
        localRuntime, localBridge, localApi: stdioApi(localStore, localRuntime, localAuthority), writebackApi: nativeWritebackApi(writeback),
        selfMcp, serviceOAuth, serviceTransports, services, installedServices, servicesBridge, servicesApi: serviceApi(installedServices, services), accounts, sse }

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

export function watchDesktopMcpOwner(runtime: DesktopRuntime, localAgentId: string): () => void {
    const entry = entryOf(runtime), generation = entry.generations.get(localAgentId) ?? 0
    const check = () => { if (entry.closed || entry.pendingOwners.get(localAgentId) || (entry.generations.get(localAgentId) ?? 0) !== generation) throw new Error('Coworker permission changed') }
    check()
    return check
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
        await service.serviceOAuth.suspendOwner(localAgentId)
        service.servicesBridge.releaseOwner(localAgentId)
        service.services.lifecycle.disconnect(localAgentId)
        await service.sse.dispose(localAgentId)
        return await service.store.lifecycle.transitionOwner(localAgentId, () => service.services.transitionOwner(localAgentId, () => service.localRuntime.transitionOwner(localAgentId, async () => { service.bridge.invalidateOwner(localAgentId); await service.localBridge.releaseOwner(localAgentId); return write() })))
    } finally {
        const count = (entry.pendingOwners.get(localAgentId) ?? 1) - 1
        if (count) entry.pendingOwners.set(localAgentId, count); else entry.pendingOwners.delete(localAgentId)
        entry.generations.set(localAgentId, (entry.generations.get(localAgentId) ?? 0) + 1)
    }
}
export async function shutdownDesktopRemoteMcp(runtime: DesktopRuntime) {
    const entry = entryOf(runtime)
    entry.closed = true
    entry.shutdown.abort()
    if (entry.service) {
        const service = await entry.service.catch(() => undefined)
        service?.oauth.shutdown()
        service?.serviceOAuth.shutdown()
        service?.bridge.shutdown()
        const stopped = await Promise.allSettled([service?.localBridge.shutdown(), service?.servicesBridge.shutdown(), service?.sse.shutdown()])
        const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'Connection shutdown is not confirmed')
    }
}

export async function handleDesktopMcpOAuth(request: Request, agentId: string): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        return await (await getDesktopRemoteMcpService(runtime)).oauthApi(request, agentId)
    } catch (error) {
        return Response.json({ state: 'error', message: 'Authorization is unavailable.' }, { status: error instanceof DesktopHttpError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
    }
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
        if (body.action === 'shutdown') {
            const outcomes = await Promise.allSettled([shutdownDesktopForeman(runtime), shutdownDesktopForemanVoice(runtime), shutdownDesktopRemoteMcp(runtime)])
            const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
            if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'Workspace shutdown is not confirmed')
            return Response.json({ stopped: true }, { headers: { 'Cache-Control': 'no-store' } })
        }
        const service = await getDesktopRemoteMcpService(runtime)
        const result = await service.bridge.handle(body, request.signal)
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
        return Response.json({ error: 'MCP request failed. Check this coworker’s permission and connection.' }, { status: error instanceof DesktopHttpError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } })
    }
}

export async function handleDesktopLocalMcp(request: Request, agentId?: string): Promise<Response> {
    try {
        const runtime = agentId ? await authenticateDesktopRequest(request) : await authenticateDesktopEngineRequest(request)
        const service = await getDesktopRemoteMcpService(runtime)
        return agentId ? service.localApi(request, agentId) : service.localBridge.api(request)
    } catch (error) {
        return Response.json({ error: 'Local MCP is unavailable.' }, { status: error instanceof DesktopHttpError ? error.status : 503 })
    }
}
export async function handleDesktopServices(request: Request, agentId?: string): Promise<Response> {
    try {
        const runtime = agentId ? await authenticateDesktopRequest(request) : await authenticateDesktopEngineRequest(request)
        const service = await getDesktopRemoteMcpService(runtime)
        return agentId ? service.servicesApi(request, agentId) : service.servicesBridge.api(request)
    } catch (error) {
        return Response.json({ error: 'Apps are unavailable. Refresh connection state before retrying.' }, { status: error instanceof DesktopHttpError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
    }
}
export async function handleDesktopNativeWriteback(request: Request, agentId?: string): Promise<Response> {
    try {
        const runtime = agentId ? await authenticateDesktopRequest(request) : await authenticateDesktopEngineRequest(request)
        const service = await getDesktopRemoteMcpService(runtime)
        return agentId ? service.writebackApi.review(request, agentId) : service.writebackApi.capture(request)
    } catch (error) {
        return Response.json({ error: 'File review is unavailable. No save acknowledgement.' }, { status: error instanceof DesktopHttpError ? error.status : 503 })
    }
}
