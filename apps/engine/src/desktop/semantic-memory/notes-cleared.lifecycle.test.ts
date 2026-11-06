import { expect, it } from 'vitest'
import type { DesktopSemanticBackendIdentity, DesktopSemanticCanonicalNote } from '@rerun/contracts'
import { createDesktopSemanticEmbedder } from './embed-adapter.js'
import { createMemorySemanticIndexStore } from './index-store.js'
import { createDesktopSemanticMemory, type DesktopSemanticMemoryDeps } from './service.js'

/** Seeded fixture vectors only — no provider HTTP. Authored unrun. */

const IDENTITY: DesktopSemanticBackendIdentity = { backendId: 'fake', model: 'fake-model', version: '1', dimensions: 4 }

function note(id: string, content: string): DesktopSemanticCanonicalNote {
    const now = '2020-01-01T00:00:00.000Z'
    return { id, content, kind: 'note', tags: [], createdAt: now, lastAccessedAt: now, accessCount: 0 }
}

function ports(seed: Record<string, DesktopSemanticCanonicalNote[]>) {
    const notes = new Map(Object.entries(seed).map(([owner, items]) => [owner, [...items]]))
    const generations = new Map<string, string>()
    const generationOf = (owner: string) => generations.get(owner) ?? (notes.get(owner) ?? []).map(item => `${item.id}:${item.content}`).join('|')
    return {
        notes,
        set(owner: string, items: DesktopSemanticCanonicalNote[], generation?: string) {
            notes.set(owner, items)
            if (generation) generations.set(owner, generation)
        },
        deps(embedding: DesktopSemanticMemoryDeps['embedding'], store: DesktopSemanticMemoryDeps['store']): DesktopSemanticMemoryDeps {
            return {
                owners: { requireCurrentOwner: async localAgentId => notes.has(localAgentId) ? { localAgentId } : null },
                notes: {
                    listNotes: async localAgentId => notes.get(localAgentId) ?? [],
                    readNote: async (localAgentId, noteId) => (notes.get(localAgentId) ?? []).find(item => item.id === noteId) ?? null,
                    generation: async localAgentId => generationOf(localAgentId),
                },
                embedding,
                store,
            }
        },
    }
}

function mapped(vectors: Map<string, number[]>) {
    return {
        identity: IDENTITY,
        embed: async (texts: readonly string[]) => texts.map(text => vectors.get(text) ?? [0, 0, 0, 1]),
    }
}

it('notesCleared empties owner records and bumps revoke so reconcile cannot resurrect them; sibling untouched', async () => {
    const content = 'private residue candidate'
    const siblingContent = 'sibling stays private'
    const vectors = new Map<string, number[]>([[content, [1, 0, 0, 0]], [siblingContent, [0, 1, 0, 0]]])
    const world = ports({ owner: [note('n1', content)], sibling: [note('s1', siblingContent)] })
    const store = createMemorySemanticIndexStore()
    const service = createDesktopSemanticMemory(world.deps(createDesktopSemanticEmbedder(mapped(vectors)), store))
    expect(await service.noteAdded('owner', 'n1')).toMatchObject({ accepted: true })
    expect(await service.noteAdded('sibling', 's1')).toMatchObject({ accepted: true })
    await service.settled()
    expect((await store.read('owner'))?.records).toHaveLength(1)
    expect((await store.read('sibling'))?.records).toHaveLength(1)

    const before = await store.read('owner')
    world.set('owner', [], 'cleared-gen')
    expect(await service.notesCleared('owner')).toMatchObject({ accepted: true, reason: 'cleared' })
    const after = await store.read('owner')
    expect(after?.records).toEqual([])
    expect(after!.revoke).toBe((before?.revoke ?? 0) + 1)
    expect((await store.read('sibling'))?.records).toHaveLength(1)

    await service.reconcile('owner')
    await service.settled()
    expect((await store.read('owner'))?.records).toEqual([])
})

it('unconfigured embedder still clears residual owner index rows without calling embed', async () => {
    const world = ports({ owner: [note('n1', 'only keyword')] })
    const store = createMemorySemanticIndexStore()
    let embeds = 0
    const embedding = {
        identity: () => null,
        embed: async () => { embeds += 1; throw new Error('no provider') },
    }
    const service = createDesktopSemanticMemory(world.deps(embedding, store))
    await store.write('owner', {
        generation: 'g',
        revoke: 3,
        invalid: false,
        records: [{
            noteId: 'n1',
            contentFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            backendFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            dimensions: 4,
            vector: [1, 0, 0, 0],
        }],
        pending: [],
    })
    world.set('owner', [], 'cleared')
    expect(await service.notesCleared('owner')).toMatchObject({ accepted: true, reason: 'cleared' })
    expect((await store.read('owner'))?.records).toEqual([])
    expect((await store.read('owner'))?.revoke).toBe(4)
    expect(embeds).toBe(0)
})
