import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AUTO_RECALL_MIN_SIMILARITY, rankRecallHits } from '../../memory/store.js'
import type { DesktopSemanticBackendIdentity, DesktopSemanticCanonicalNote } from '@rerun/contracts'
import { createDesktopSemanticEmbedder } from './embed-adapter.js'
import { createFileSemanticIndexStore, createMemorySemanticIndexStore, initializeDesktopSemanticIndex } from './index-store.js'
import { createDesktopSemanticMemory, type DesktopSemanticMemoryDeps } from './service.js'

const IDENTITY: DesktopSemanticBackendIdentity = { backendId: 'fake', model: 'fake-model', version: '1', dimensions: 4 }

function recent(): string {
    return new Date().toISOString()
}

function note(id: string, content: string, patch: Partial<DesktopSemanticCanonicalNote> = {}): DesktopSemanticCanonicalNote {
    const now = recent()
    return { id, content, kind: 'note', tags: [], createdAt: now, lastAccessedAt: now, accessCount: 0, ...patch }
}

function ports(seed: Record<string, DesktopSemanticCanonicalNote[]>) {
    const notes = new Map(Object.entries(seed).map(([owner, items]) => [owner, [...items]]))
    const generations = new Map<string, string>()
    const generationOf = (owner: string) => generations.get(owner) ?? (notes.get(owner) ?? []).map(item => `${item.id}:${item.content}`).join('|')
    return {
        notes,
        generationOf,
        set(owner: string, items: DesktopSemanticCanonicalNote[], generation?: string) {
            notes.set(owner, items)
            if (generation) generations.set(owner, generation)
        },
        deps(embedding: DesktopSemanticMemoryDeps['embedding'], store: DesktopSemanticMemoryDeps['store'], onReinforce?: DesktopSemanticMemoryDeps['onReinforce']): DesktopSemanticMemoryDeps {
            return {
                owners: { requireCurrentOwner: async localAgentId => notes.has(localAgentId) ? { localAgentId } : null },
                notes: {
                    listNotes: async localAgentId => notes.get(localAgentId) ?? [],
                    readNote: async (localAgentId, noteId) => (notes.get(localAgentId) ?? []).find(item => item.id === noteId) ?? null,
                    generation: async localAgentId => generationOf(localAgentId),
                },
                embedding,
                store,
                onReinforce,
            }
        },
    }
}

function mapped(vectors: Map<string, number[]>, mode: 'ready' | 'hang' | 'throw' | 'nan' | 'short' | 'refuse' = 'ready', holds = Number.POSITIVE_INFINITY) {
    let arrived: () => void = () => undefined
    let held = 0
    const releases: Array<() => void> = []
    const capability = {
        identity: IDENTITY,
        embed: async (texts: readonly string[], signal: AbortSignal) => {
            arrived()
            if (mode === 'hang' && held < holds) {
                held += 1
                await new Promise<void>((resolve, reject) => {
                    releases.push(resolve)
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                })
            }
            if (mode === 'throw') throw new Error('offline')
            if (mode === 'refuse') return 'refused' as const
            if (mode === 'nan') return texts.map(() => [Number.NaN, 0, 0, 0])
            if (mode === 'short') return texts.map(() => [1, 0, 0])
            return texts.map(text => vectors.get(text) ?? [0, 0, 0, 1])
        },
    }
    return { capability, releases, listen(next: () => void) { arrived = next } }
}

async function indexNote(deps: DesktopSemanticMemoryDeps, owner: string, id: string) {
    const service = createDesktopSemanticMemory(deps)
    expect(await service.noteAdded(owner, id)).toMatchObject({ accepted: true })
    await service.settled()
    return service
}

describe('desktop semantic recall', () => {
    it('keeps the original floor and keyword coverage bonus', () => {
        expect(AUTO_RECALL_MIN_SIMILARITY).toBe(0.25)
        const now = recent()
        const [hit] = rankRecallHits([{ kind: 'note', createdAt: now, lastAccessedAt: now, accessCount: 0, similarity: 0.5, coverage: 1 }], 1, { minSimilarity: AUTO_RECALL_MIN_SIMILARITY })
        expect(hit?.score).toBeCloseTo((hit?.strength ?? 0) * (0.5 + 0.15), 5)
    })

    it('returns a related note that shares no words', async () => {
        const content = 'whiskered animal that lives indoors'
        const vectors = new Map<string, number[]>([[content, [1, 0, 0, 0]], ['feline', [1, 0, 0, 0]]])
        const world = ports({ owner: [note('cat', content)] })
        const embedder = mapped(vectors)
        const service = await indexNote(world.deps(createDesktopSemanticEmbedder(embedder.capability), createMemorySemanticIndexStore()), 'owner', 'cat')
        const result = await service.recall('owner', { query: 'feline', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(result.mode).toBe('semantic')
        expect(result.memories.map(item => item.id)).toEqual(['cat'])
        expect(result.memories[0]?.content).toBe(content)
    })

    it('lets an exact keyword reference outrank a weaker semantic neighbor', async () => {
        const exact = 'printer toner cabinet'
        const related = 'office supply closet'
        const vectors = new Map<string, number[]>([
            [exact, [0.8, 0.6, 0, 0]],
            [related, [0.6, 0.8, 0, 0]],
            ['printer toner', [1, 0, 0, 0]],
        ])
        const world = ports({ owner: [note('exact', exact), note('related', related)] })
        const store = createMemorySemanticIndexStore()
        const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), store))
        await service.noteAdded('owner', 'exact')
        await service.noteAdded('owner', 'related')
        await service.settled()
        const result = await service.recall('owner', { query: 'printer toner', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(result.memories.map(item => item.id)).toEqual(['exact', 'related'])
    })

    it('drops an irrelevant cosine and keeps a keyword hit with no vector', async () => {
        const vectors = new Map<string, number[]>([
            ['unrelated ballast', [0, 1, 0, 0]],
            ['badge', [1, 0, 0, 0]],
        ])
        const world = ports({ owner: [note('low', 'unrelated ballast'), note('word', 'badge holder')] })
        const store = createMemorySemanticIndexStore()
        const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), store))
        await service.noteAdded('owner', 'low')
        await service.settled()
        const result = await service.recall('owner', { query: 'badge', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(result.memories.map(item => item.id)).toEqual(['word'])
        expect(result.mode).toBe('partial')
    })

    it('filters dormant notes unless asked and reinforces only through the callback', async () => {
        const content = 'legacy cron jenkins'
        const vectors = new Map<string, number[]>([[content, [1, 0, 0, 0]], ['legacy cron', [1, 0, 0, 0]]])
        const dormant = note('old', content, { kind: 'task', createdAt: '2000-01-01T00:00:00.000Z', lastAccessedAt: '2000-01-01T00:00:00.000Z' })
        const world = ports({ owner: [dormant] })
        const reinforced: Array<{ ids: readonly string[]; mode: string }> = []
        const service = await indexNote(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), createMemorySemanticIndexStore(), async (_owner, ids, mode) => { reinforced.push({ ids, mode }) }), 'owner', 'old')
        const hidden = await service.recall('owner', { query: 'legacy cron', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(hidden.memories).toEqual([])
        expect(reinforced).toEqual([])
        const shown = await service.recall('owner', { query: 'legacy cron', limit: 5, includeDormant: true, reinforce: 'full' })
        expect(shown.memories.map(item => item.id)).toEqual(['old'])
        expect(reinforced).toEqual([{ ids: ['old'], mode: 'full' }])
        await service.recall('owner', { query: 'legacy cron', limit: 5, includeDormant: true, reinforce: 'touch' })
        expect(reinforced.at(-1)).toEqual({ ids: ['old'], mode: 'touch' })
    })

    it('rejects corrupt and mixed-dimension vectors and still returns keyword matches', async () => {
        for (const failure of ['nan', 'short'] as const) {
            const world = ports({ owner: [note('note', 'badge holder')] })
            const embedder = mapped(new Map(), failure)
            const store = createMemorySemanticIndexStore()
            const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(embedder.capability), store))
            await service.noteAdded('owner', 'note')
            await service.settled()
            expect((await store.read('owner'))?.records).toEqual([])
            const result = await service.recall('owner', { query: 'badge', limit: 5, includeDormant: false, reinforce: 'none' })
            expect(result.mode).toBe('keyword-only')
            expect(result.memories.map(item => item.id)).toEqual(['note'])
            expect(result.detail.startsWith('Keyword search only.')).toBe(true)
        }
    })

    it('stays on keyword search when the backend is missing, offline, or refuses', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        const world = ports({ owner: [note('note', 'badge holder')] })
        const missing = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(null), createMemorySemanticIndexStore()))
        const missingResult = await missing.recall('owner', { query: 'badge', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(missingResult.mode).toBe('keyword-only')
        expect(missingResult.detail).toContain('not configured')
        expect(missingResult.memories.map(item => item.id)).toEqual(['note'])
        expect(fetchMock).not.toHaveBeenCalled()

        for (const failure of ['throw', 'refuse'] as const) {
            const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(new Map([['badge', [1, 0, 0, 0]]]), failure).capability), createMemorySemanticIndexStore()))
            await service.noteAdded('owner', 'note')
            await service.settled()
            const result = await service.recall('owner', { query: 'badge', limit: 5, includeDormant: false, reinforce: 'none' })
            expect(result.mode).toBe('keyword-only')
            expect(result.memories.map(item => item.id)).toEqual(['note'])
            expect(result.mode).not.toBe('semantic')
        }
        vi.unstubAllGlobals()
    })

    it('does not publish a vector after the note is edited, deleted, or cleared', async () => {
        const original = 'alpha sentence about olives'
        const edited = 'beta sentence about figs'
        const vectors = new Map<string, number[]>([[original, [1, 0, 0, 0]], [edited, [0, 1, 0, 0]]])
        const world = ports({ owner: [note('note', original)] })
        const embedder = mapped(vectors, 'hang', 1)
        const store = createMemorySemanticIndexStore()
        const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(embedder.capability), store))
        const entered = new Promise<void>(resolve => embedder.listen(resolve))
        void service.noteAdded('owner', 'note')
        await entered
        world.set('owner', [note('note', edited)])
        await service.noteUpdated('owner', 'note')
        embedder.releases[0]?.()
        await service.settled()
        const saved = await store.read('owner')
        expect(saved?.records).toHaveLength(1)
        expect(saved?.records[0]?.vector).toEqual([0, 1, 0, 0])

        const deleted = ports({ owner: [note('gone', original)] })
        const deleting = mapped(vectors, 'hang')
        const deleteStore = createMemorySemanticIndexStore()
        const deleteService = createDesktopSemanticMemory(deleted.deps(createDesktopSemanticEmbedder(deleting.capability), deleteStore))
        const sawDelete = new Promise<void>(resolve => deleting.listen(resolve))
        void deleteService.noteAdded('owner', 'gone')
        await sawDelete
        deleted.set('owner', [])
        await deleteService.noteDeleted('owner', 'gone')
        await deleteService.settled()
        expect((await deleteStore.read('owner'))?.records).toEqual([])
        expect(deleted.notes.get('owner')).toEqual([])

        const cleared = ports({ owner: [note('gone', original)] })
        const clearing = mapped(vectors, 'hang')
        const clearStore = createMemorySemanticIndexStore()
        const clearService = createDesktopSemanticMemory(cleared.deps(createDesktopSemanticEmbedder(clearing.capability), clearStore))
        const sawClear = new Promise<void>(resolve => clearing.listen(resolve))
        void clearService.noteAdded('owner', 'gone')
        await sawClear
        cleared.set('owner', [], 'cleared-1')
        await clearService.notesCleared('owner')
        await clearService.settled()
        expect((await clearStore.read('owner'))?.records).toEqual([])
        expect(cleared.notes.get('owner')).toEqual([])
    })

    it('reconciles a lost publish after restart without recreating a deleted note', async () => {
        const content = 'whiskered animal that lives indoors'
        const vectors = new Map<string, number[]>([[content, [1, 0, 0, 0]]])
        const world = ports({ owner: [note('cat', content)] })
        const embedder = mapped(vectors, 'hang')
        const store = createMemorySemanticIndexStore()
        const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(embedder.capability), store))
        const entered = new Promise<void>(resolve => embedder.listen(resolve))
        void service.noteAdded('owner', 'cat')
        await entered
        await service.shutdown()
        embedder.releases[0]?.()
        await service.settled()
        expect((await store.read('owner'))?.records ?? []).toEqual([])
        const restarted = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), store))
        await restarted.reconcile('owner')
        await restarted.settled()
        expect((await store.read('owner'))?.records).toHaveLength(1)
        expect(world.notes.get('owner')).toHaveLength(1)

        world.set('owner', [])
        const afterDelete = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), store))
        await afterDelete.reconcile('owner')
        await afterDelete.settled()
        expect((await store.read('owner'))?.records).toEqual([])
        expect(world.notes.get('owner')).toEqual([])
    })

    it('does not return another coworker’s notes', async () => {
        const own = 'own private note'
        const other = 'other private note'
        const vectors = new Map<string, number[]>([[own, [1, 0, 0, 0]], [other, [1, 0, 0, 0]], ['private', [1, 0, 0, 0]]])
        const world = ports({ alpha: [note('own', own)], beta: [note('other', other)] })
        const store = createMemorySemanticIndexStore()
        const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), store))
        await service.noteAdded('alpha', 'own')
        await service.noteAdded('beta', 'other')
        await service.settled()
        const result = await service.recall('alpha', { query: 'private', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(result.memories.map(item => item.content)).toEqual([own])
        expect(await service.noteAdded('alpha', 'other')).toMatchObject({ accepted: false, reason: 'missing' })
        expect(await service.recall('gamma', { query: 'private', limit: 5 })).toMatchObject({ mode: 'unavailable', memories: [] })
    })

    it('reloads a persisted index after the process restarts', async () => {
        const content = 'whiskered animal that lives indoors'
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'semantic-memory-')))
        try {
            await initializeDesktopSemanticIndex(directory)
            const world = ports({ owner: [note('cat', content)] })
            const vectors = new Map<string, number[]>([[content, [1, 0, 0, 0]]])
            const first = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), createFileSemanticIndexStore(directory)))
            await first.noteAdded('owner', 'cat')
            await first.settled()
            await first.shutdown()
            const second = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors).capability), createFileSemanticIndexStore(directory)))
            expect((await second.status('owner')).indexed).toBe(1)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
})
