import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { DesktopMcpSseRef } from '@rerun/contracts'
import type { DesktopRuntime } from '../../runtime'
import type { ServiceInstall, ServiceStore } from '../store'
import type { LocalServices, ServiceRun, ServiceTransport } from '../lifecycle'
import type { AccountCompilePlan } from '../accounts/compiler'
import { legacyCompatibleHeaderSecrets, sqliteHeaderSecrets } from '../accounts/secret-store'
import { desktopServiceRegistryName } from '../service-registry'
import { getDesktopServiceManifest } from '../catalog/index'
import type { createDesktopSseBinding } from '../../mcp-sse/binding'
import { wait } from '../../mcp-sse/errors'
import { toToolInputSchema } from '../../mcp-sse/tool-schema'
import { compileServiceTransport, TransportFailure } from './compiler'
import { createServiceTransports } from './lifecycle'
import { canonicalSseServiceDriver } from './drivers'
import { serviceTransportStore } from './store'
import type { TransportAuthority, TransportDependencies, TransportReceiptKey } from './types'
import type { ServiceTransportRef } from '@rerun/contracts'
const serverId = (installationId: string) => `app-${installationId}`
function requestId(parts: unknown[]) { const bytes = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16); bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128; const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` }
export function createCanonicalServiceTransports(runtime: DesktopRuntime, store: ServiceStore, services: LocalServices, key: () => Buffer, remoteAccess: (owner: string) => Promise<{ enabled: boolean; granted: boolean }>, shutdownSignal: AbortSignal, sse: () => ReturnType<typeof createDesktopSseBinding>) {
    const secrets = legacyCompatibleHeaderSecrets(store, sqliteHeaderSecrets(store.db, key)), durable = serviceTransportStore(store.db)
    const reference = (record: ServiceInstall): ServiceTransportRef => ({ agentId: record.owner, key: record.key, installationId: record.id, revision: record.revision })
    async function current(ref: ServiceTransportRef, action: 'read' | 'discover' | 'call' | 'close', run: ServiceRun | undefined, signal: AbortSignal) {
        const check = services.lifecycle.watch(ref.agentId, desktopServiceRegistryName(ref.installationId))
        const use = action === 'discover' || action === 'call'
        const authority = await services.current(ref.agentId, use ? 'use' : 'manage', run, signal), record = await store.read(ref.agentId, ref.key)
        if (!record || record.id !== ref.installationId || record.revision !== ref.revision || record.engineId !== authority.engineAgentId || (record.plan as AccountCompilePlan).transport !== 'sse' || use && record.state !== 'ready') throw new TransportFailure('changed')
        const remote = await remoteAccess(ref.agentId)
        if (use && (!remote.enabled || !remote.granted)) throw new TransportFailure('grant')
        if (use) await services.skillAuthority.assertReady(record.owner, record.id, signal)
        const savedSecret = (await store.db.execute({ sql: 'SELECT revision,bundle FROM desktop_service_header_secrets WHERE owner=? AND installation_id=?', args: [record.owner, record.id] })).rows[0]
        const plan = record.plan as AccountCompilePlan
        if (!['anonymous', 'bearer'].includes(plan.shape) || use && plan.shape === 'bearer' && (!savedSecret || savedSecret.revision !== record.revision)) throw new TransportFailure('auth-needed')
        const credentialGeneration = store.digest(record.owner, [record.id, record.revision, savedSecret?.bundle ?? (plan.shape === 'anonymous' ? 'anonymous' : 'missing')])
        authority.check?.(); check(); signal.throwIfAborted(); shutdownSignal.throwIfAborted()
        return { record, plan, authority, remote, credentialGeneration, check: () => { authority.check?.(); check(); signal.throwIfAborted(); shutdownSignal.throwIfAborted() } }
    }
    async function material(record: ServiceInstall) {
        const plan = record.plan as AccountCompilePlan
        if (plan.shape === 'anonymous') return ''
        const bundle = await secrets.read(record.owner, record.id, record.revision)
        if (!bundle || Object.keys(bundle.headers).length !== 1 || !bundle.headers.Authorization?.startsWith('Bearer ')) throw new TransportFailure('auth-needed')
        try { const value = bundle.headers.Authorization.slice(7); if (!/^[\x21-\x7e]{1,8192}$/.test(value)) throw new TransportFailure('auth-needed'); return value }
        finally { for (const values of [bundle.headers, bundle.inputs]) for (const name of Object.keys(values)) values[name] = '' }
    }
    const active = new Set<{ key: TransportReceiptKey; controller: AbortController; done: Promise<void> }>()
    const operations: TransportDependencies['operations'] = {
        admit(key, controller) {
            const ticket = services.lifecycle.admit(key.ref.agentId, desktopServiceRegistryName(key.ref.installationId), controller)
            let finish!: () => void
            const entry = { key, controller, done: new Promise<void>(resolve => { finish = resolve }) }; active.add(entry)
            return { check: ticket.assertCurrent, release() { ticket.release(); active.delete(entry); finish() } }
        },
        async cancel(ref, run, signal) {
            const selected = [...active].filter(row => row.key.ref.agentId === ref.agentId && row.key.ref.installationId === ref.installationId && (!run || JSON.stringify(row.key.run) === JSON.stringify(run)))
            selected.forEach(row => row.controller.abort())
            await wait(Promise.all(selected.map(row => row.done)), signal)
        },
    }
    const driver = canonicalSseServiceDriver(sse().runtime, {
        async reference(a, resolved) {
            const row = await current(a.ref, 'read', undefined, AbortSignal.any([shutdownSignal, AbortSignal.timeout(10_000)]))
            if (resolved && (resolved.transport !== 'sse' || resolved.url !== row.plan.url || (resolved.bearer ?? '') !== await material(row.record))) throw new TransportFailure('changed')
            return { agentId: row.record.owner, name: row.plan.serverName, serverId: serverId(row.record.id), expectedRevision: row.record.revision }
        },
        releaseServerRun: (ref, run, signal) => wait(sse().releaseServerRun(ref.agentId, ref.serverId, run), signal),
    })
    const unavailable = async (): Promise<never> => { throw new TransportFailure('unsupported') }
    const transport = createServiceTransports({
        async authority(ref, action, run, signal): Promise<TransportAuthority> {
            const value = await current(ref, action, run, signal), plan = compileServiceTransport(getDesktopServiceManifest(value.plan.slug).manifest, value.plan.methodId, ref)
            if (plan.transport !== 'sse' || plan.serverName !== value.plan.serverName) throw new TransportFailure('changed')
            return { ref, methodId: value.plan.methodId, plan, engineOwnerId: value.record.engineId, configurationGeneration: value.record.revision, credentialGeneration: value.credentialGeneration, enabled: value.authority.enabled, appsGranted: value.authority.granted, remoteGranted: value.remote.granted, programGranted: false, check: value.check }
        },
        values: {
            async read(ref, inputKey, signal) { const value = await current(ref, 'discover', undefined, signal); return value.plan.credentialInputs.includes(inputKey) ? { kind: 'secret', reference: { installationId: ref.installationId, revision: ref.revision, inputKey } } : value.plan.publicInputs[inputKey] !== undefined ? { kind: 'public', value: value.plan.publicInputs[inputKey] } : null },
            async unseal(ref, raw, signal) { const value = await current(ref, 'discover', undefined, signal), handle = raw as { installationId?: unknown; revision?: unknown; inputKey?: unknown }; if (handle.installationId !== ref.installationId || handle.revision !== ref.revision || handle.inputKey !== value.plan.secretInput) throw new TransportFailure('changed'); return material(value.record) },
        },
        programs: { resolve: async () => null, validateExecutable: unavailable, validateArguments: unavailable },
        drivers: { sse: driver, stdio: { status: unavailable, discover: unavailable, call: unavailable, drain: unavailable, releaseRun: unavailable } }, receipts: durable.receipts, operations, shutdownSignal,
        normalizeTool(tool) { const { schema, note } = toToolInputSchema(tool.inputSchema); return { name: tool.name, inputSchema: schema, ...(tool.description || note ? { description: [tool.description, note].filter(Boolean).join('\n\n') } : {}) } },
        protect: value => value,
        assertToolNames: (names, ref) => services.assertToolNames(ref.agentId, ref.installationId, names, AbortSignal.any([shutdownSignal, AbortSignal.timeout(10_000)])),
    })
    return {
        runtime: transport, pending: durable.pending,
        async account(ref: DesktopMcpSseRef, action: 'read' | 'use' | 'call' | 'close', run: ServiceRun | undefined, signal: AbortSignal) {
            if (!ref.serverId.startsWith('app-')) return null
            const rows = (await store.list(ref.agentId)).filter(record => serverId(record.id) === ref.serverId)
            if (rows.length !== 1) throw new TransportFailure('changed')
            const row = rows[0], value = await current(reference(row), action === 'use' ? 'discover' : action, run, signal)
            if (ref.expectedRevision !== row.revision || ref.name !== value.plan.serverName) throw new TransportFailure('changed')
            const bearer = action === 'read' || action === 'close' ? '' : await material(row)
            value.check()
            return { server: { id: ref.serverId, transport: 'sse' as const, name: value.plan.serverName, revision: row.revision, url: value.plan.url, hasBearer: value.plan.shape === 'bearer' }, bearer, credentialGeneration: value.credentialGeneration, check: value.check }
        },
        service(record: ServiceInstall, run: ServiceRun | undefined, parent: AbortSignal): ServiceTransport | undefined {
            if ((record.plan as AccountCompilePlan).transport !== 'sse') return undefined
            const ref = reference(record)
            const aligned = (owner: string, name: string, revision: string) => { if (owner !== record.owner || name !== services.idName(record) || revision !== record.revision) throw new TransportFailure('changed') }
            return {
                async probe(owner, name, revision, stop) { aligned(owner, name, revision); const signal = AbortSignal.any([parent, ...(stop ? [stop] : [])]); const found = run ? await transport.discoverForRun(ref, requestId(['service-sse-discover', ref, run]), run, signal) : await transport.control({ ...ref, action: 'probe', requestId: randomUUID() }, signal); if (found.receipt?.outcome !== 'completed' || found.observation === 'saved') throw new TransportFailure('unknown'); return { tools: found.tools } },
                async call(owner, name, revision, tool, args, stop, invocation) { aligned(owner, name, revision); if (!run || !invocation?.toolCallId) throw new TransportFailure('changed'); const signal = AbortSignal.any([parent, ...(stop ? [stop] : [])]); const result = await transport.call(ref, { requestId: requestId(['service-sse-call', ref, run, invocation.toolCallId]), toolCallId: invocation.toolCallId, tool, arguments: args, run }, signal); if (!('result' in result)) throw new TransportFailure('unknown'); return { result: result.result as Record<string, unknown> } },
                async validate(owner, name, revision, signal) { aligned(owner, name, revision); await current(ref, 'call', run, signal) },
            }
        },
        async releaseRun(owner: string, run: ServiceRun, signal: AbortSignal) {
            const rows = (await store.list(owner)).filter(record => (record.plan as AccountCompilePlan).transport === 'sse')
            for (const record of rows) { await operations.cancel(reference(record), run, signal); await wait(sse().releaseServerRun(owner, serverId(record.id), run), signal) }
        },
        async beforeChange(owner: string, installationId: string) { await operations.cancel({ agentId: owner, installationId, key: '', revision: '' }, undefined, AbortSignal.timeout(15_000)); await sse().dispose(owner, serverId(installationId)) },
        authorize: current,
    }
}
