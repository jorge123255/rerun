import { createClient } from '@libsql/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopToolInstallRunIdentity, DesktopToolInstallSnapshot } from '@rerun/contracts'
import { desktopToolInstallStore } from './store'

const dbs: ReturnType<typeof createClient>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const identity: DesktopToolInstallRunIdentity = {
    agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', proposalRevision: '1',
    guest: { engineAgentId: 'engine', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) },
}
const snapshot: DesktopToolInstallSnapshot = {
    operationId: 'a'.repeat(64), agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', proposalRevision: '1', revision: '1', status: 'pending-approval',
    packages: [{ package: 'left-pad@1.2.3', status: 'pending' }], guestId: 'b'.repeat(64), availability: 'isolated-guest-only', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z',
}

function fixture() {
    const db = createClient({ url: 'file::memory:' })
    dbs.push(db)
    return desktopToolInstallStore(db)
}

describe('durable tool install store', () => {
    it('persists reservations, completions and session history with exact identity', async () => {
        const store = fixture()
        await expect(store.begin(identity, snapshot.operationId, ['left-pad@1.2.3'])).resolves.toBe('execute')
        await store.complete(identity, snapshot)
        await expect(store.read(snapshot.operationId)).resolves.toEqual(snapshot)
        await expect(store.list('session')).resolves.toEqual([snapshot])
        await expect(store.list('other')).resolves.toEqual([])
    })

    it('refuses identity changes and older completion revisions', async () => {
        const store = fixture()
        await store.begin(identity, snapshot.operationId, ['left-pad@1.2.3'])
        await store.complete(identity, snapshot)
        await expect(store.begin({ ...identity, proposalRevision: '2' }, snapshot.operationId, ['left-pad@1.2.3'])).rejects.toThrow('identity conflict')
        await expect(store.complete(identity, snapshot)).rejects.toThrow('completion conflict')
    })

    it('completes an interrupted null reservation instead of treating it as an installation', async () => {
        const store = fixture()
        await store.begin(identity, snapshot.operationId, ['left-pad@1.2.3'])
        await expect(store.read(snapshot.operationId)).resolves.toBeNull()
        await store.complete(identity, snapshot)
        await expect(store.read(snapshot.operationId)).resolves.toEqual(snapshot)
    })

    it('refuses completion without a prior reservation', async () => {
        const store = fixture()
        await expect(store.complete(identity, snapshot)).rejects.toThrow('reservation is missing')
    })
})
