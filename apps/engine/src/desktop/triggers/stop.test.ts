import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { createDesktopTriggerStore } from './state.js'
import { stopDesktopTriggerRun } from './stop.js'
import type { DesktopTriggerAuthority } from './types.js'
import { randomUUID } from 'node:crypto'

describe('stopDesktopTriggerRun', () => {
    it('cancels only the exact owned run and leaves siblings alone', async () => {
        const client = createClient({ url: ':memory:' })
        const store = createDesktopTriggerStore(async () => client)
        await store.initialize('eng-1')
        await store.recordEvent({
            eventId: 'e1', attemptFingerprint: null, localAgentId: 'local-1', engineAgentId: 'eng-1', slug: 'hook',
            triggerName: 'Hook', method: 'POST', receivedAt: new Date().toISOString(), status: 'running',
            localSessionId: 'local-sess', engineSessionId: 'eng-sess', runId: 'run-1', revision: 'r1', error: null,
            payloadBytes: 0, truncated: false, capturedPayload: true, payloadPreview: '',
        })
        await store.recordEvent({
            eventId: 'e2', attemptFingerprint: null, localAgentId: 'local-1', engineAgentId: 'eng-1', slug: 'hook',
            triggerName: 'Hook', method: 'POST', receivedAt: new Date().toISOString(), status: 'running',
            localSessionId: 'other-sess', engineSessionId: 'eng-sess-2', runId: 'run-2', revision: 'r1', error: null,
            payloadBytes: 0, truncated: false, capturedPayload: true, payloadPreview: '',
        })
        let cancelled = false
        const cancelExactRun = vi.fn(async () => { cancelled = true })
        const authority = {
            assertActive: () => {},
            resolveOwnerByEngineId: async () => ({ localAgentId: 'local-1', engineAgentId: 'eng-1', enabled: true, deleting: false }),
            assertTriggerGrant: async () => {},
            assertSetupClear: async () => {},
            resolveAutomationModel: async () => ({ connectionId: null, provider: null, model: null }),
            startTriggerRun: async () => ({ runId: 'x', sessionId: 'y' }),
            cancelExactRun,
            readRun: async (_a: string, runId: string) => ({
                id: runId, sessionId: runId === 'run-1' ? 'eng-sess' : 'eng-sess-2', status: cancelled && runId === 'run-1' ? 'cancelled' : 'running', agentId: 'eng-1', triggerSource: 'trigger', triggerSlug: 'hook',
            }),
            readSession: async () => null,
            adoptTriggerSession: async () => ({ agentId: 'local-1', engineAgentId: 'eng-1', sessionId: 'local-sess', engineSessionId: 'eng-sess', tabUid: 'trigger:local-sess', title: 'Hook', runId: 'run-1' }),
            routeHuman: async () => {},
            ingressOrigin: () => ({ enabled: false, origin: null, bindHost: '127.0.0.1' as const, bindPort: null, hostingDecision: 'unresolved' as const }),
            listTriggers: async () => [],
            readTrigger: async () => null,
            writeTrigger: async () => { throw new Error('no') },
            rotateTriggerToken: async () => { throw new Error('no') },
            deleteTrigger: async () => {},
            markFired: async () => {},
        } satisfies DesktopTriggerAuthority

        const requestId = randomUUID()
        const result = await stopDesktopTriggerRun({
            authority,
            store,
            engineAgentId: 'eng-1',
            localAgentId: 'local-1',
            body: { requestId, localSessionId: 'local-sess', runId: 'run-1', expectedEventId: 'e1' },
        })
        expect(result.canceled).toBe(true)
        expect(cancelExactRun).toHaveBeenCalledTimes(1)
        expect(cancelExactRun).toHaveBeenCalledWith('eng-1', 'run-1')
        expect((await store.getEvent('eng-1', 'e2'))?.status).toBe('running')
        expect((await store.getEvent('eng-1', 'e1'))?.status).toBe('cancelled')
        await expect(stopDesktopTriggerRun({ authority, store, engineAgentId: 'eng-1', localAgentId: 'local-1', body: { requestId, localSessionId: 'other-sess', runId: 'run-2', expectedEventId: 'e2' } })).rejects.toMatchObject({ status: 409 })
        expect(cancelExactRun).toHaveBeenCalledTimes(1)
    })
})
