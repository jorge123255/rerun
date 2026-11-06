import { createClient } from '@libsql/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopClaudePlanAttempt, DesktopClaudePlanChatResult } from '@rerun/contracts'
import { desktopClaudePlanStore } from './store'

const dbs: ReturnType<typeof createClient>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const attempt: DesktopClaudePlanAttempt = {
    attemptId: 'a'.repeat(64), agentId: 'agent', revision: '1', phase: 'waiting', authorizeUrl: 'https://claude.ai/', verifier: 'v', state: 's', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z', expiresAt: '2026-11-05T10:15:00.000Z',
}
const result: DesktopClaudePlanChatResult = {
    operationId: 'b'.repeat(64), agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', credentialRevision: '1', status: 'completed', text: 'Hello', model: 'claude-sonnet-4-6', events: [], createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z',
}

function fixture() {
    const db = createClient({ url: 'file::memory:' })
    dbs.push(db)
    return desktopClaudePlanStore(db)
}

describe('desktop Claude plan stores', () => {
    it('persists auth attempts and monotonic revisions', async () => {
        const store = fixture()
        await expect(store.attempts.begin(attempt)).resolves.toBe('execute')
        await store.attempts.complete(attempt)
        await expect(store.attempts.active('agent')).resolves.toEqual(attempt)
        await expect(store.attempts.complete({ ...attempt, revision: '1' })).rejects.toThrow('completion conflict')
        await store.attempts.complete({ ...attempt, revision: '2', phase: 'connected', credentialRevision: '1' })
        await expect(store.attempts.connected('agent')).resolves.toMatchObject({ phase: 'connected' })
    })

    it('persists chat outcomes and replays them without begin execution', async () => {
        const store = fixture()
        await expect(store.chats.begin(result, result.operationId)).resolves.toBe('execute')
        await store.chats.complete(result)
        await expect(store.chats.read(result.operationId)).resolves.toEqual(result)
        await expect(store.chats.begin(result, result.operationId)).resolves.toEqual(result)
        await expect(store.chats.begin({ ...result, toolCallId: 'other' }, result.operationId)).rejects.toThrow('identity conflict')
    })

    it('rejects completion without reservations and conflicting results', async () => {
        const store = fixture()
        await expect(store.attempts.complete(attempt)).rejects.toThrow('reservation is missing')
        await expect(store.chats.complete(result)).rejects.toThrow('reservation is missing')
    })
})
