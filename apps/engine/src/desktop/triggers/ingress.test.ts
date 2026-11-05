import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { createDesktopTriggerIngressHandler } from './ingress.js'
import { createDesktopTriggerStore } from './state.js'
import type { DesktopTriggerAuthority, DesktopTriggerRecord } from './types.js'

function memoryStore() {
    const client = createClient({ url: ':memory:' })
    return createDesktopTriggerStore(async () => client)
}

function record(partial: Partial<DesktopTriggerRecord> = {}): DesktopTriggerRecord {
    return {
        slug: 'hook',
        name: 'Hook',
        description: '',
        enabled: true,
        token: 'secret-token-value-0001',
        methods: ['POST'],
        lastFiredAt: null,
        fireCount: 0,
        connectionId: null,
        provider: null,
        model: null,
        body: 'Handle the event.',
        createdAt: new Date().toISOString(),
        ...partial,
    }
}

function authority(trigger: DesktopTriggerRecord, opts: { setup?: boolean; grant?: boolean; deleting?: boolean; enabled?: boolean } = {}): DesktopTriggerAuthority {
    let nextRun = 0
    const start = vi.fn(async (input: Parameters<DesktopTriggerAuthority['startTriggerRun']>[0]) => {
        const suffix = ++nextRun, sessionId = `sess-${suffix}`, runId = `run-${suffix}`
        await input.onSessionCreated(sessionId); await input.onRunCreated(runId, sessionId); await input.assertActive()
        return { runId, sessionId, settled: Promise.resolve({ kind: 'done' as const }) }
    })
    return {
        assertActive: () => {},
        resolveOwnerByEngineId: async () => ({ localAgentId: 'local-1', engineAgentId: 'eng-1', enabled: opts.enabled !== false, deleting: opts.deleting === true }),
        assertTriggerGrant: async () => { if (opts.grant === false) throw new Error('missing trigger grant') },
        assertSetupClear: async () => { if (opts.setup) throw new Error('setup pending') },
        resolveAutomationModel: async () => ({ connectionId: null, provider: null, model: null }),
        startTriggerRun: start,
        cancelExactRun: async () => {},
        readRun: async () => null,
        readSession: async () => null,
        adoptTriggerSession: async input => ({ agentId: input.localAgentId, engineAgentId: input.engineAgentId, sessionId: `local-${input.engineSessionId}`, engineSessionId: input.engineSessionId, tabUid: `trigger:local-${input.engineSessionId}`, title: 'Hook', runId: input.runId }),
        routeHuman: async () => {},
        ingressOrigin: () => ({ enabled: false, origin: null, bindHost: '127.0.0.1', bindPort: null, hostingDecision: 'unresolved' }),
        listTriggers: async () => [trigger],
        readTrigger: async (_id, slug) => (slug === trigger.slug ? trigger : null),
        writeTrigger: async () => trigger,
        rotateTriggerToken: async () => trigger,
        deleteTrigger: async () => {},
        markFired: async () => {},
        // expose for assertions
        ...({ start } as object),
    } as DesktopTriggerAuthority & { start: typeof start }
}

describe('desktop trigger ingress', () => {
    it('returns 204 for passive visits and never starts a run', async () => {
        const store = memoryStore()
        const auth = authority(record())
        const ingress = createDesktopTriggerIngressHandler({ authority: auth, store })
        const res = await ingress.handle(new Request('http://127.0.0.1/t', { method: 'POST', headers: { 'user-agent': 'Twitterbot' }, body: '{}' }), {
            engineAgentId: 'eng-1', slug: 'hook', token: 'secret-token-value-0001',
        })
        expect(res.status).toBe(204)
        expect((auth as any).start).not.toHaveBeenCalled()
    })

    it('answers 404 for bad tokens and strips secrets from refusals', async () => {
        const store = memoryStore()
        const auth = authority(record())
        const ingress = createDesktopTriggerIngressHandler({ authority: auth, store })
        const res = await ingress.handle(new Request('http://127.0.0.1/t', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain', authorization: 'Bearer leak' } }), {
            engineAgentId: 'eng-1', slug: 'hook', token: 'wrong',
        })
        expect(res.status).toBe(404)
        expect((auth as any).start).not.toHaveBeenCalled()
    })

    it('rejects oversized bodies before materializing a run', async () => {
        const store = memoryStore()
        const auth = authority(record())
        const ingress = createDesktopTriggerIngressHandler({ authority: auth, store })
        const res = await ingress.handle(new Request('http://127.0.0.1/t', {
            method: 'POST',
            headers: { 'content-length': String(2_000_000) },
            body: 'x',
        }), { engineAgentId: 'eng-1', slug: 'hook', token: 'secret-token-value-0001' })
        expect(res.status).toBe(413)
    })

    it('creates distinct events for independent calls and replays explicit attempt fingerprints', async () => {
        const store = memoryStore()
        await store.initialize('eng-1')
        const auth = authority(record())
        const ingress = createDesktopTriggerIngressHandler({ authority: auth, store })
        const mk = (attempt?: string, body = '{"a":1}') => ingress.handle(new Request('http://127.0.0.1/t', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(attempt ? { 'x-desktop-trigger-attempt': attempt } : {}) },
            body,
        }), { engineAgentId: 'eng-1', slug: 'hook', token: 'secret-token-value-0001' })
        const a = await mk()
        const b = await mk()
        expect(a.status).toBe(202)
        expect(b.status).toBe(202)
        const aj = await a.json() as { eventId: string }
        const bj = await b.json() as { eventId: string }
        expect(aj.eventId).not.toEqual(bj.eventId)
        expect((auth as any).start).toHaveBeenCalledTimes(2)

        const c = await mk('same-attempt')
        const d = await mk('same-attempt')
        const cj = await c.json() as { eventId: string; replay: boolean }
        const dj = await d.json() as { eventId: string; replay: boolean }
        expect(cj.eventId).toEqual(dj.eventId)
        expect(dj.replay).toBe(true)
        expect((auth as any).start).toHaveBeenCalledTimes(3)
        expect((await mk('same-attempt', '{"a":2}')).status).toBe(409)
        expect((auth as any).start).toHaveBeenCalledTimes(3)
    })

    it('refuses disabled/deleting/pending-setup/missing-grant before effects', async () => {
        const store = memoryStore()
        await store.initialize('eng-1')
        for (const opts of [{ enabled: false }, { deleting: true }, { setup: true }, { grant: false }] as const) {
            const auth = authority(record(), opts as any)
            const ingress = createDesktopTriggerIngressHandler({ authority: auth, store })
            const res = await ingress.handle(new Request('http://127.0.0.1/t', { method: 'POST', body: '{}' }), {
                engineAgentId: 'eng-1', slug: 'hook', token: 'secret-token-value-0001',
            })
            expect([404, 409]).toContain(res.status)
            expect((auth as any).start).not.toHaveBeenCalled()
        }
    })

    it('HEAD/OPTIONS never start a run', async () => {
        const store = memoryStore()
        const auth = authority(record())
        const ingress = createDesktopTriggerIngressHandler({ authority: auth, store })
        expect(ingress.HEAD().status).toBe(200)
        expect(ingress.OPTIONS().status).toBe(204)
        expect((auth as any).start).not.toHaveBeenCalled()
    })
})
