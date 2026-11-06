import { createServiceTransports } from './lifecycle'
import { compileServiceTransport } from './compiler'
import { serviceManifestSchema } from '@/lib/services/manifest'
import type { TransportDependencies, TransportAuthority, TransportReceiptKey } from './types'
import type { ServiceTransportRef, ServiceTransportReceipt } from '@rerun/contracts'
export const ref: ServiceTransportRef = { agentId: 'alice', key: 'example', installationId: '00000000-0000-4000-8000-000000000001', revision: '00000000-0000-4000-8000-000000000002' }
export const requestId = '00000000-0000-4000-8000-000000000003'
export const run = { engineAgentId: 'engine', sessionId: 'session', runId: 'run' }
export function harness(transport: 'sse' | 'stdio' = 'sse') {
    const manifest = serviceManifestSchema.parse({ slug: 'example', name: 'Example', mcpServers: [{ name: 'example', transport, ...(transport === 'sse' ? { url: 'https://example.org/sse' } : { command: '/usr/local/bin/example' }) }] })
    let a: TransportAuthority = { ref, plan: compileServiceTransport(manifest, 'default', ref), methodId: 'default', credentialGeneration: 'credential-1', configurationGeneration: 'configuration-1', engineOwnerId: 'engine', enabled: true, appsGranted: true, remoteGranted: true, programGranted: true, check() {} }
    const invocationKeys = new Set<string>()
    const claims = new Map<string, { fingerprint: string; receipt?: ServiceTransportReceipt }>(), active = new Set<AbortController>()
    const tools = [{ name: 'work', description: 'Works', inputSchema: { type: 'object', properties: {} } }]
    const effects = { discover: 0, calls: 0, drains: 0, runDrains: 0, reads: 0 }
    let failClose = false, failSettle = false, waitCall: Promise<void> | undefined
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    const key = (k: TransportReceiptKey) => JSON.stringify([k.ref.agentId, k.ref.installationId, k.requestId])
    const deps: TransportDependencies = {
        authority: async r => { effects.reads++; if (r.agentId !== a.ref.agentId || r.revision !== a.ref.revision || r.installationId !== a.ref.installationId || r.key !== a.ref.key) throw Error('changed'); return { ...a } },
        values: { read: async () => null, unseal: async () => { throw Error('unseal must not run') } },
        programs: { resolve: async () => ({ executable: '/usr/local/bin/example', args: [], supportsEnvironment: false }), validateExecutable: async () => 'inode', validateArguments: async () => {} },
        drivers: {} as TransportDependencies['drivers'],
        receipts: {
            async claim(k, fingerprint) { const invocation = k.toolCallId ? JSON.stringify([k.ref.agentId, k.ref.installationId, k.run, k.toolCallId]) : undefined; const id = key(k), prior = claims.get(id); if (prior) { if (prior.fingerprint !== fingerprint) throw Error('reused'); return 'existing' }; if (invocation && invocationKeys.has(invocation)) throw Error('invocation reused'); if (invocation) invocationKeys.add(invocation); claims.set(id, { fingerprint }); return 'new' },
            async read(k) { return claims.get(key(k))?.receipt ?? null },
            async settle(k, fingerprint, receipt) { if (failSettle) throw Error('lost ACK'); if (claims.get(key(k))?.fingerprint !== fingerprint) throw Error('conflict'); claims.set(key(k), { fingerprint, receipt }) },
        },
        operations: {
            admit(_k, controller) { active.add(controller); return { check() { controller.signal.throwIfAborted() }, release() { active.delete(controller) } } },
            async cancel(r) { if (r.installationId !== ref.installationId) throw Error('wrong account'); for (const c of active) c.abort() },
        },
        normalizeTool: tool => ({ ...tool }),
        protect(value) { return JSON.parse(JSON.stringify(value).replaceAll('private-value', '[redacted]')) }, assertToolNames: async () => {}, shutdownSignal: new AbortController().signal,
    }
    const driver = {
        status: async () => ({ state: 'unchecked' as const, tools: [] }),
        async discover() { effects.discover++; return { tools, observation: 'live' as const } },
        async call(context: Parameters<TransportDependencies['drivers']['sse']['call']>[0]) { effects.calls++; announce(); if (waitCall) await waitCall; context.signal.throwIfAborted(); return { content: [{ type: 'text', text: 'private-value' }] } },
        async drain() { effects.drains++; if (failClose) throw Error('still running') }, async releaseRun() { effects.runDrains++ },
    }
    deps.drivers = { sse: driver, stdio: driver }
    return { deps, started, runtime: createServiceTransports(deps), effects, claims, set: (patch: Partial<TransportAuthority>) => { a = { ...a, ...patch } }, closeFailure: (v: boolean) => { failClose = v }, settlementFailure: (v: boolean) => { failSettle = v }, hold: (p?: Promise<void>) => { waitCall = p } }
}
