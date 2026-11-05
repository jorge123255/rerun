import { describe, expect, it, vi } from 'vitest'
import { delegationApi } from './api'
import type { DelegationRuntime } from '../../../../../engine/src/desktop/delegation/runtime'

const snapshot = { delegationId: crypto.randomUUID(), revision: crypto.randomUUID(), parentAgentId: 'owner', parentSessionId: 'session', parentRunId: 'run', toolCallId: 'tool', tasks: [] }

function runtimeWith(overrides: Partial<DelegationRuntime> = {}) {
    return {
        list: vi.fn(async () => [snapshot]),
        stop: vi.fn(async () => snapshot),
        ...overrides,
    } as unknown as DelegationRuntime
}

const owner = { parentAgentId: 'owner', parentSessionId: 'session' }
const authorize = vi.fn(async () => owner)

describe('authenticated delegation API', () => {
    it('reads only the authorized parent history without creating work', async () => {
        const runtime = runtimeWith()
        const api = delegationApi(runtime, authorize)
        const response = await api(new Request('http://local.test/api/desktop/sessions/session/delegation'), 'session')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ delegations: [snapshot] })
        expect(runtime.list).toHaveBeenCalledWith('session')
    })

    it('accepts only exact stop-task input and returns the acknowledged snapshot', async () => {
        const runtime = runtimeWith()
        const api = delegationApi(runtime, authorize)
        const body = { operation: 'stop-task', requestId: crypto.randomUUID(), delegationId: snapshot.delegationId, taskId: crypto.randomUUID(), expectedRevision: snapshot.revision }
        const response = await api(new Request('http://local.test/api/desktop/sessions/session/delegation', { method: 'POST', body: JSON.stringify(body) }), 'session')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ delegation: snapshot })
        expect(runtime.stop).toHaveBeenCalledWith(owner, body)
    })

    it('rejects unknown operations, oversized bodies and changed ownership without calling Stop', async () => {
        const runtime = runtimeWith()
        const api = delegationApi(runtime, authorize)
        const unknown = await api(new Request('http://local.test/api/desktop/sessions/session/delegation', { method: 'POST', body: JSON.stringify({ operation: 'stop-all' }) }), 'session')
        expect(unknown.status).toBe(409)
        const oversized = await api(new Request('http://local.test/api/desktop/sessions/session/delegation', { method: 'POST', body: 'x'.repeat(4097) }), 'session')
        expect(oversized.status).toBe(409)
        expect(runtime.stop).not.toHaveBeenCalled()

        let calls = 0
        const changing = delegationApi(runtimeWith(), vi.fn(async () => ++calls === 1 ? owner : { ...owner, parentAgentId: 'other' }))
        const body = { operation: 'stop-task', requestId: crypto.randomUUID(), delegationId: snapshot.delegationId, taskId: crypto.randomUUID(), expectedRevision: snapshot.revision }
        const changed = await changing(new Request('http://local.test/api/desktop/sessions/session/delegation', { method: 'POST', body: JSON.stringify(body) }), 'session')
        expect(changed.status).toBe(409)
        expect(runtime.stop).not.toHaveBeenCalled()
    })
})
