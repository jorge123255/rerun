import { describe, expect, it } from 'vitest'
import { createServiceTransportClient } from '@/lib/desktop/service-transports-client'
import type { ServiceTransportControl, ServiceTransportSnapshot } from '@rerun/contracts'
import { ref, requestId } from './regression-harness'
describe('restart-safe public request journal', () => {
    it('hydrates without an operation and reconciles the exact unknown acknowledgement', async () => {
        let saved: ServiceTransportControl | null = null, posts = 0
        const ports = { uuid: () => requestId, journal: { read: async () => saved, put: async (r: ServiceTransportControl) => { saved = r }, clear: async (r: ServiceTransportControl) => { if (saved?.requestId === r.requestId) saved = null } },
            post: async () => { posts++; throw Error('lost ACK') }, reconcile: async (r: ServiceTransportControl) => ({ ok: true as const, snapshot: { ref, transport: 'sse' as const, methodId: 'default', state: 'unchecked' as const, tools: [], observation: 'saved' as const, receipt: { ref, requestId: r.requestId, action: r.action as 'probe', outcome: 'completed' as const, state: 'healthy' as const } } }) }
        const first = createServiceTransportClient(ports)
        await expect(first.perform(ref, 'probe', new AbortController().signal)).rejects.toThrow()
        const restarted = createServiceTransportClient(ports)
        const pending = await restarted.pending(ref)
        expect(pending?.requestId).toBe(requestId); expect(posts).toBe(1)
        await restarted.reconcile(pending!, new AbortController().signal)
        expect(saved).toBeNull(); expect(posts).toBe(1)
    })
    it('does not clear a foreign acknowledgement', async () => {
        let cleared = 0
        const command = { ...ref, action: 'probe' as const, requestId }
        const client = createServiceTransportClient({ uuid: () => requestId, journal: { read: async () => command, put: async () => {}, clear: async () => { cleared++ } }, post: async () => ({ ok: true, snapshot: { ref: { ...ref, agentId: 'foreign' }, transport: 'sse', methodId: 'default', state: 'healthy', tools: [], observation: 'probe' } as ServiceTransportSnapshot }), reconcile: async () => { throw Error() } })
        await expect(client.perform(ref, 'probe', new AbortController().signal)).rejects.toThrow(); expect(cleared).toBe(0)
    })
    it('never stores setup secrets in the transport journal', async () => {
        let saved: unknown
        const client = createServiceTransportClient({ uuid: () => requestId, journal: { read: async () => null, put: async request => { saved = request }, clear: async () => {} }, post: async () => { throw Error() }, reconcile: async () => { throw Error() } })
        await expect(client.perform(ref, 'probe', new AbortController().signal)).rejects.toThrow()
        expect(Object.keys(saved as object).sort()).toEqual(['action', 'agentId', 'installationId', 'key', 'requestId', 'revision'])
    })
})
