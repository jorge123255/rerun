import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { createDesktopTriggerStore } from './state.js'
import { recoverDesktopTriggerOwner } from './recovery.js'
import type { DesktopTriggerAuthority } from './types.js'

describe('recoverDesktopTriggerOwner', () => {
    it('never relaunches runs and marks active admissions uncertain', async () => {
        const client = createClient({ url: ':memory:' })
        const store = createDesktopTriggerStore(async () => client)
        await store.initialize('eng-1')
        await store.recordEvent({
            eventId: 'e1', attemptFingerprint: null, localAgentId: 'local-1', engineAgentId: 'eng-1', slug: 'hook',
            triggerName: 'Hook', method: 'POST', receivedAt: new Date().toISOString(), status: 'running',
            localSessionId: 'l1', engineSessionId: 's1', runId: 'run-1', revision: 'r1', error: null,
            payloadBytes: 0, truncated: false, capturedPayload: true, payloadPreview: '',
        })
        const startTriggerRun = vi.fn(async () => ({ runId: 'new', sessionId: 'new' }))
        const authority = {
            assertActive: () => {},
            resolveOwnerByEngineId: async () => ({ localAgentId: 'local-1', engineAgentId: 'eng-1', enabled: true, deleting: false }),
            assertTriggerGrant: async () => {},
            assertSetupClear: async () => {},
            resolveAutomationModel: async () => ({ connectionId: null, provider: null, model: null }),
            startTriggerRun,
            cancelExactRun: async () => {},
            readRun: async () => ({ id: 'run-1', sessionId: 's1', status: 'running', agentId: 'eng-1', triggerSource: 'trigger', triggerSlug: 'hook' }),
            readSession: async () => ({ id: 's1', agentId: 'eng-1', source: 'trigger', title: 'Hook' }),
            adoptTriggerSession: async () => ({ agentId: 'local-1', engineAgentId: 'eng-1', sessionId: 'l1', engineSessionId: 's1', tabUid: 'trigger:l1', title: 'Hook', runId: 'run-1' }),
            routeHuman: async () => {},
            ingressOrigin: () => ({ enabled: false, origin: null, bindHost: '127.0.0.1' as const, bindPort: null, hostingDecision: 'unresolved' as const }),
            listTriggers: async () => [],
            readTrigger: async () => null,
            writeTrigger: async () => { throw new Error('no') },
            rotateTriggerToken: async () => { throw new Error('no') },
            deleteTrigger: async () => {},
            markFired: async () => {},
        } satisfies DesktopTriggerAuthority

        const result = await recoverDesktopTriggerOwner({ authority, store, engineAgentId: 'eng-1' })
        expect(startTriggerRun).not.toHaveBeenCalled()
        expect(result.uncertain).toBe(1)
        expect((await store.getEvent('eng-1', 'e1'))?.status).toBe('uncertain')
    })
})
