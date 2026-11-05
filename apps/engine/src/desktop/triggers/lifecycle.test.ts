import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { createDesktopTriggerLifecycle } from './lifecycle.js'
import { createDesktopTriggerStore } from './state.js'
import type { DesktopTriggerAuthority, DesktopTriggerRecord } from './types.js'
import { randomUUID } from 'node:crypto'

function memoryStore() {
    const client = createClient({ url: ':memory:' })
    return createDesktopTriggerStore(async () => client)
}

describe('desktop trigger lifecycle idempotency', () => {
    it('replays create/rotate/delete acknowledgements without double effects', async () => {
        const store = memoryStore()
        await store.initialize('eng-1')
        let token = 'token-a'
        let existing: DesktopTriggerRecord | null = null
        const writes = vi.fn(async (input: any) => {
            existing = {
                slug: 'hook',
                name: input.name,
                description: input.description,
                enabled: input.enabled,
                token: input.token ?? token,
                methods: input.methods,
                lastFiredAt: null,
                fireCount: 0,
                connectionId: null,
                provider: null,
                model: null,
                body: input.body,
                createdAt: new Date().toISOString(),
            }
            return existing
        })
        const rotates = vi.fn(async (_id: string, _slug: string, next: string) => {
            token = next
            existing = { ...existing!, token: next }
            return existing
        })
        const deletes = vi.fn(async () => { existing = null })
        const authority: DesktopTriggerAuthority = {
            assertActive: () => {},
            resolveOwnerByEngineId: async () => ({ localAgentId: 'local-1', engineAgentId: 'eng-1', enabled: true, deleting: false }),
            assertTriggerGrant: async () => {},
            assertSetupClear: async () => {},
            resolveAutomationModel: async () => ({ connectionId: null, provider: null, model: null }),
            startTriggerRun: async () => ({ runId: 'r', sessionId: 's' }),
            cancelExactRun: async () => {},
            readRun: async () => null,
            readSession: async () => null,
            adoptTriggerSession: async () => ({ agentId: 'local-1', engineAgentId: 'eng-1', sessionId: 'l', engineSessionId: 's', tabUid: 'trigger:l', title: 'Hook', runId: null }),
            routeHuman: async () => {},
            ingressOrigin: () => ({ enabled: false, origin: null, bindHost: '127.0.0.1', bindPort: null, hostingDecision: 'unresolved' }),
            listTriggers: async () => (existing ? [existing] : []),
            readTrigger: async () => existing,
            writeTrigger: writes,
            rotateTriggerToken: rotates,
            deleteTrigger: deletes,
            markFired: async () => {},
            replaceTrigger: async (_id, _slug, _before, next) => {
                if (!next) { await deletes(); return null }
                if (existing && existing.token !== next.token) await rotates(_id, _slug, next.token)
                else await writes(next)
                existing = next
                return existing
            },
        }
        const life = createDesktopTriggerLifecycle(authority, store)
        const requestId = randomUUID()
        const created = await life.create('eng-1', { requestId, name: 'Hook', description: '', body: 'Do it', methods: ['POST'], provider: null, model: null })
        const createdAgain = await life.create('eng-1', { requestId, name: 'Hook', description: '', body: 'Do it', methods: ['POST'], provider: null, model: null })
        expect(created.revision).toEqual(createdAgain.revision)
        expect(writes).toHaveBeenCalledTimes(1)
        await expect(life.create('eng-1', { requestId, name: 'Hook', description: '', body: 'Changed body', methods: ['POST'], provider: null, model: null })).rejects.toMatchObject({ status: 409 })

        const stopped = vi.fn(async () => { throw new Error('Run stopped') })
        await expect(life.update('eng-1', 'hook', { requestId: randomUUID(), expectedRevision: created.revision, body: 'Do not write this' }, stopped)).rejects.toThrow('Run stopped')
        expect(existing!.body).toBe('Do it')
        expect(writes).toHaveBeenCalledTimes(1)

        const rotateId = randomUUID()
        vi.spyOn(store, 'completeIntent').mockRejectedValueOnce(new Error('Lost acknowledgement'))
        await expect(life.rotate('eng-1', 'hook', { requestId: rotateId, expectedRevision: created.revision })).rejects.toThrow('Lost acknowledgement')
        const rotated = await life.rotate('eng-1', 'hook', { requestId: rotateId, expectedRevision: created.revision })
        const rotatedAgain = await life.rotate('eng-1', 'hook', { requestId: rotateId, expectedRevision: created.revision })
        expect(rotated.token).toEqual(rotatedAgain.token)
        expect(rotates).toHaveBeenCalledTimes(1)

        await expect(life.rotate('eng-1', 'hook', { requestId: randomUUID(), expectedRevision: created.revision })).rejects.toMatchObject({ status: 409 })

        const deleteId = randomUUID()
        const deleted = await life.remove('eng-1', 'hook', { requestId: deleteId, expectedRevision: rotated.revision })
        const deletedAgain = await life.remove('eng-1', 'hook', { requestId: deleteId, expectedRevision: rotated.revision })
        expect(deleted).toEqual(deletedAgain)
        expect(deletes).toHaveBeenCalledTimes(1)
    })
})
