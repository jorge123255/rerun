import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { SERVICE_TRANSPORT_SCHEMA_SQL, serviceTransportStore } from './store'
import type { TransportReceiptKey } from './types'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ref = { agentId: 'a', key: 'fixture', installationId: uuid(1), revision: uuid(2) }
const signal = () => new AbortController().signal
it('durable claimed calls survive reopen and cannot be rekeyed or replaced by another invocation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rerun-transport-receipts-')), url = `file:${join(dir, 'db')}`
    let db = createClient({ url })
    try {
        await db.executeMultiple(SERVICE_TRANSPORT_SCHEMA_SQL)
        const key: TransportReceiptKey = { ref, requestId: uuid(3), action: 'call', run: { engineAgentId: 'engine', sessionId: 's', runId: 'r' }, toolCallId: 'call-A' }
        let store = serviceTransportStore(db)
        expect(await store.receipts.claim(key, 'digest-A', signal())).toBe('new')
        db.close(); db = createClient({ url }); store = serviceTransportStore(db)
        expect(await store.receipts.claim(key, 'digest-A', signal())).toBe('existing')
        expect(await store.receipts.read(key, signal())).toBeNull()
        await expect(store.receipts.claim({ ...key, requestId: uuid(4) }, 'digest-A', signal())).rejects.toThrow()
        await expect(store.receipts.claim(key, 'digest-B', signal())).rejects.toThrow()
        const receipt = { ref, requestId: key.requestId, action: 'call' as const, outcome: 'completed' as const, state: 'healthy' as const }
        await store.receipts.settle(key, 'digest-A', receipt)
        await expect(store.receipts.settle(key, 'digest-A', { ...receipt, outcome: 'uncertain' })).rejects.toThrow()
        expect(await store.receipts.read(key, signal())).toEqual(receipt)
        expect(await store.receipts.read({ ...key, run: { ...key.run!, sessionId: 'sibling' } }, signal())).toBeNull()
    } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})
it('pending operations use exact request CAS and close retries can settle an uncertain receipt', async () => {
    const db = createClient({ url: ':memory:' })
    try {
        await db.executeMultiple(SERVICE_TRANSPORT_SCHEMA_SQL)
        const store = serviceTransportStore(db), request = { ...ref, requestId: uuid(3), action: 'stop' as const }
        await store.pending.put(request)
        await expect(store.pending.put({ ...request, requestId: uuid(4) })).rejects.toThrow()
        await store.pending.clear({ ...request, requestId: uuid(4) })
        expect(await store.pending.read(ref)).toEqual(request)
        const key: TransportReceiptKey = { ref, requestId: request.requestId, action: 'stop' }
        await store.receipts.claim(key, 'close', signal())
        await store.receipts.settle(key, 'close', { ref, requestId: request.requestId, action: 'stop', outcome: 'uncertain', state: 'closing' })
        await store.receipts.settle(key, 'close', { ref, requestId: request.requestId, action: 'stop', outcome: 'completed', state: 'disconnected' })
        expect((await store.receipts.read(key, signal()))?.outcome).toBe('completed')
        await store.pending.clear(request); expect(await store.pending.read(ref)).toBeNull()
    } finally { db.close() }
})
