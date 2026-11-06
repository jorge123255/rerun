import { describe, expect, it, vi } from 'vitest'
import {
    DESKTOP_SEMANTIC_BATCH_MAX,
    DESKTOP_SEMANTIC_PENDING_MAX,
    type DesktopSemanticBackendIdentity,
    type DesktopSemanticCanonicalNote,
} from '@rerun/contracts'
import { createDesktopSemanticEmbedder } from './embed-adapter.js'
import { desktopSemanticBackendFingerprint, desktopSemanticContentFingerprint } from './identity.js'
import { createMemorySemanticIndexStore } from './index-store.js'
import { createDesktopSemanticMemory, type DesktopSemanticMemoryDeps } from './service.js'

const identity: DesktopSemanticBackendIdentity = { backendId: 'regression', model: 'fake', version: '1', dimensions: 2 }

function note(id: string, content: string): DesktopSemanticCanonicalNote {
    const now = new Date().toISOString()
    return { id, content, kind: 'note', tags: [], createdAt: now, lastAccessedAt: now, accessCount: 0 }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

async function heldQuery() {
    const saved = note('private-note', 'A private note about the printer cabinet')
    const store = createMemorySemanticIndexStore()
    await store.write('owner', {
        generation: 'current', revoke: 0, invalid: false, pending: [],
        records: [{
            noteId: saved.id,
            contentFingerprint: desktopSemanticContentFingerprint(saved.content),
            backendFingerprint: desktopSemanticBackendFingerprint(identity),
            dimensions: identity.dimensions,
            vector: [1, 0],
        }],
    })
    const entered = deferred<AbortSignal>()
    const completion = deferred<number[][]>()
    const state = { authorized: true }
    const reinforce = vi.fn<NonNullable<DesktopSemanticMemoryDeps['onReinforce']>>(async () => {})
    const service = createDesktopSemanticMemory({
        owners: { requireCurrentOwner: async ownerId => state.authorized && ownerId === 'owner' ? { localAgentId: ownerId } : null },
        notes: {
            listNotes: async () => [saved],
            readNote: async (_ownerId, noteId) => noteId === saved.id ? saved : null,
            generation: async () => 'current',
        },
        embedding: createDesktopSemanticEmbedder({
            identity,
            embed: async (_texts, signal) => {
                entered.resolve(signal)
                return completion.promise
            },
        }),
        store,
        onReinforce: reinforce,
    })
    const query = (signal?: AbortSignal) => service.recall('owner', { query: 'private note', limit: 5, includeDormant: false, reinforce: 'full' }, signal)
    return { service, query, state, reinforce, entered: entered.promise, complete: () => completion.resolve([[1, 0]]) }
}

describe('semantic recall authority after asynchronous work', () => {
    it('does not return or reinforce still-readable notes after owner authorization is revoked during query embedding', async () => {
        const f = await heldQuery()
        const pending = f.query()
        try {
            await f.entered
            f.state.authorized = false
            f.complete()
            const result = await pending
            expect(result.memories).toEqual([])
            expect(result.mode).toBe('unavailable')
            expect(f.reinforce).not.toHaveBeenCalled()
        } finally {
            f.complete()
            await pending
            await f.service.shutdown()
        }
    })

    it.each(['cancel', 'shutdown', 'request'] as const)('%s aborts an outstanding query and refuses its late result and keyword fallback', async operation => {
        const f = await heldQuery()
        const request = new AbortController()
        const pending = f.query(request.signal)
        try {
            const signal = await f.entered
            if (operation === 'cancel') await f.service.cancel('owner')
            else if (operation === 'shutdown') await f.service.shutdown()
            else request.abort()
            expect(signal.aborted).toBe(true)
            f.complete()
            const result = await pending
            expect(result.memories).toEqual([])
            expect(result.mode).toBe('unavailable')
            expect(f.reinforce).not.toHaveBeenCalled()
        } finally {
            f.complete()
            await pending
            if (operation !== 'shutdown') await f.service.shutdown()
        }
    })
})

describe('semantic indexing beyond the pending queue window', () => {
    it('finishes a single reconcile across multiple bounded queue windows without user retry', async () => {
        const count = DESKTOP_SEMANTIC_PENDING_MAX * 2 + 1
        const notes = Array.from({ length: count }, (_, index) => note(`note-${String(index).padStart(3, '0')}`, `Private memory number ${index}`))
        const byId = new Map(notes.map(item => [item.id, item]))
        const store = createMemorySemanticIndexStore()
        const writes = vi.spyOn(store, 'write')
        const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]))
        const service = createDesktopSemanticMemory({
            owners: { requireCurrentOwner: async ownerId => ownerId === 'owner' ? { localAgentId: ownerId } : null },
            notes: {
                listNotes: async () => notes,
                readNote: async (_ownerId, noteId) => byId.get(noteId) ?? null,
                generation: async () => 'unchanged-notes',
            },
            embedding: createDesktopSemanticEmbedder({ identity, embed }),
            store,
        })
        try {
            expect(await service.reconcile('owner')).toMatchObject({ accepted: true })
            await service.settled()

            const indexed = await store.read('owner')
            expect(indexed?.records.map(record => record.noteId).sort()).toEqual(notes.map(item => item.id).sort())
            expect(indexed?.pending).toEqual([])
            expect(await service.status('owner')).toMatchObject({ mode: 'ready', indexed: count, pending: 0, omitted: 0 })
            const submitted = embed.mock.calls.flatMap(([texts]) => [...texts])
            expect(submitted.sort()).toEqual(notes.map(item => item.content).sort())
            expect(embed.mock.calls.every(([texts]) => texts.length > 0 && texts.length <= DESKTOP_SEMANTIC_BATCH_MAX)).toBe(true)
            expect(writes.mock.calls.every(([, index]) => index.pending.length <= DESKTOP_SEMANTIC_PENDING_MAX)).toBe(true)
        } finally {
            await service.shutdown()
        }
    })
})
