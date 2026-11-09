import { expect, it, vi } from 'vitest'
import type { DesktopBrainSemanticBackend, DesktopBrainSemanticIndexEntry, DesktopBrainSemanticPage, DesktopBrainSemanticPending, DesktopBrainSemanticPorts } from '@rerun/contracts'
import { createDesktopBrainSemanticIndex } from './service.js'
const page = (patch: Partial<DesktopBrainSemanticPage> = {}): DesktopBrainSemanticPage => ({ slug: 'pricing', title: 'Pricing', type: 'offering', hash: 'a'.repeat(32), content: '## Overview\n\nOur pricing is public.', sources: [], unconfirmed: [], links: [], updatedAt: '', updatedBy: 'user', ...patch })
function fixture(initial = [page()]) {
    let backend: DesktopBrainSemanticBackend | null = { model: 'embedding', version: '1', dimensions: 2, revision: crypto.randomUUID() }
    let pages = initial
    const entries = new Map<string, DesktopBrainSemanticIndexEntry>(), pending = new Map<string, DesktopBrainSemanticPending>()
    const embedding = { identity: vi.fn(() => backend), embed: vi.fn(async (texts: readonly string[]) => texts.map(text => text.includes('Canines') || text === 'Dogs need regular walks' ? [1, 0] : [0, 1])) }
    const ports: DesktopBrainSemanticPorts = {
        authority: vi.fn(async () => {}), embedding,
        pages: { list: vi.fn(async () => pages), read: vi.fn(async slug => pages.find(p => p.slug === slug) ?? null), search: vi.fn(async () => ({ hits: [], related: [] })) },
        store: {
            list: async () => [...entries.values()], pending: async () => [...pending.values()],
            write: async value => { entries.set(value.chunk.id, value) }, queue: async value => { pending.set(value.chunk.id, value) },
            remove: async ids => { for (const id of ids) entries.delete(id) }, removePending: async ids => { for (const id of ids) pending.delete(id) },
            removePage: async slug => { for (const [id, value] of entries) if (value.chunk.slug === slug) entries.delete(id) },
        },
    }
    return { ports, entries, pending, embedding, setPages: (value: DesktopBrainSemanticPage[]) => { pages = value }, setBackend: (value: DesktopBrainSemanticBackend | null) => { backend = value } }
}

// Synthetic embedding oracle, not a live provider acceptance claim.
it('reopened Brain index retrieves a keyword-free paraphrase and separates unavailable/changed provider fallback', async () => {
    const f = fixture([page({ title: 'Care', content: '## Routine\n\nCanines require daily exercise' })])
    let service = createDesktopBrainSemanticIndex(f.ports)
    const query = { query: 'Dogs need regular walks' }
    await service.reconcile(true)
    expect((await service.search(query)).hits.map(hit => hit.slug)).toEqual(['pricing'])
    service = createDesktopBrainSemanticIndex(f.ports) // reuse persisted port state, recreate service
    expect((await service.search(query)).hits.map(hit => hit.slug)).toEqual(['pricing'])
    f.embedding.embed.mockRejectedValue(new Error('synthetic offline'))
    expect((await service.search(query)).hits).toEqual([])
    expect(f.ports.pages.search).toHaveBeenCalled()
    f.setBackend(null)
    expect((await service.search(query)).hits).toEqual([])
    f.setBackend({ model: 'changed', version: '2', dimensions: 2, revision: crypto.randomUUID() })
    expect((await service.search(query)).hits).toEqual([])
    f.setPages([])
    await service.reconcile(false)
    expect(f.entries.size).toBe(0)
    expect((await service.search(query)).hits).toEqual([])
})
