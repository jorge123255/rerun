import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { DesktopSemanticCanonicalNote } from '@rerun/contracts'
import { createFileSemanticIndexStore } from './index-store.js'
import { createDesktopSemanticEmbedder } from './embed-adapter.js'
import { createDesktopSemanticMemory } from './service.js'

// Synthetic semantic oracle: proves adapter/index/ranking wiring, NOT a model's language quality.
const saved = 'Canines require daily exercise'
const paraphrase = 'Dogs need regular walks'
const unrelated = 'Invoices expire quarterly'
const vector = (text: string) => text === saved || text === paraphrase ? [1, 0] : [0, 1]
const note = (id: string, content: string): DesktopSemanticCanonicalNote => ({ id, content, kind: 'fact', tags: [], createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), accessCount: 0 })

it('configured paraphrase survives index reopen, unlike keyword fallback; provider rotation, owner and clear are isolated', async () => {
    expect(saved.toLowerCase().split(/\W+/).filter(word => paraphrase.toLowerCase().split(/\W+/).includes(word))).toEqual([])
    const directory = await mkdtemp(join(tmpdir(), 'semantic-acceptance-'))
    const notes = new Map([['owner', [note('walks', saved), note('billing', unrelated)]], ['sibling', [note('private', unrelated)]]])
    let offline = false
    const embed = vi.fn(async (texts: readonly string[]) => { if (offline) throw new Error('synthetic unavailable'); return texts.map(vector) })
    const open = (model: string | null = 'fixture-v1') => createDesktopSemanticMemory({
        owners: { requireCurrentOwner: async localAgentId => notes.has(localAgentId) ? { localAgentId } : null },
        notes: { listNotes: async owner => notes.get(owner) ?? [], readNote: async (owner, id) => notes.get(owner)?.find(item => item.id === id) ?? null, generation: async owner => JSON.stringify(notes.get(owner) ?? []) },
        embedding: createDesktopSemanticEmbedder(model ? { identity: { backendId: 'offline-fixture', model, version: '1', dimensions: 2 }, embed } : null),
        store: createFileSemanticIndexStore(directory),
    })
    const query = { query: paraphrase, limit: 5, includeDormant: false, reinforce: 'none' as const }
    let service = open()
    try {
        await service.reconcile('owner'); await service.reconcile('sibling'); await service.settled()
        expect(await service.recall('owner', query)).toMatchObject({ mode: 'semantic', memories: [{ id: 'walks' }] })
        expect((await service.recall('sibling', query)).memories.map(item => item.id)).not.toContain('walks')
        expect((await service.recall('unowned', query)).memories).toEqual([])
        await service.shutdown(); service = open()
        expect(await service.recall('owner', query)).toMatchObject({ mode: 'semantic', memories: [{ id: 'walks' }] })
        offline = true
        expect((await service.recall('owner', query)).memories).toEqual([])
        expect(await service.recall('owner', { ...query, query: 'Canines' })).toMatchObject({ mode: 'keyword-only', memories: [{ id: 'walks' }] })
        await service.shutdown(); service = open(null)
        expect(await service.recall('owner', query)).toMatchObject({ mode: 'keyword-only', memories: [] })
        await service.shutdown(); offline = false; service = open('fixture-v2')
        expect((await service.recall('owner', query)).memories).toEqual([])
        await service.reconcile('owner'); await service.settled()
        expect((await service.recall('owner', query)).memories.map(item => item.id)).toEqual(['walks'])
        notes.set('owner', [])
        await service.notesCleared('owner'); await service.settled()
        await service.shutdown(); service = open('fixture-v2')
        expect((await service.recall('owner', query)).memories).toEqual([])
        expect((await createFileSemanticIndexStore(directory).read('owner'))?.records).toEqual([])
    } finally { await service.shutdown(); await rm(directory, { recursive: true, force: true }) }
})

it('clear drains a delayed provider without republishing stale vectors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'semantic-drain-'))
    let notes = [note('walks', saved)]
    let finish!: (vectors: number[][]) => void, enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const store = createFileSemanticIndexStore(directory)
    const service = createDesktopSemanticMemory({
        owners: { requireCurrentOwner: async localAgentId => localAgentId === 'owner' ? { localAgentId } : null },
        notes: { listNotes: async () => notes, readNote: async (_, id) => notes.find(item => item.id === id) ?? null, generation: async () => notes.length ? 'before' : 'cleared' },
        embedding: createDesktopSemanticEmbedder({ identity: { backendId: 'offline-fixture', model: 'delayed', version: '1', dimensions: 2 }, embed: async () => { enter(); return new Promise(resolve => { finish = resolve }) } }), store,
    })
    try {
        await service.reconcile('owner'); await entered
        notes = []
        const clear = service.notesCleared('owner')
        finish([[1, 0]])
        await clear; await service.settled()
        expect((await store.read('owner'))?.records).toEqual([])
        expect((await store.read('owner'))?.pending).toEqual([])
    } finally { finish?.([[1, 0]]); await service.shutdown(); await rm(directory, { recursive: true, force: true }) }
})
