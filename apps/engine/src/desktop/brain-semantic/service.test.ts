import { describe, expect, it, vi } from 'vitest'
import type { DesktopBrainSemanticBackend, DesktopBrainSemanticIndexEntry, DesktopBrainSemanticPage, DesktopBrainSemanticPending, DesktopBrainSemanticPorts } from '@rerun/contracts'
import { createDesktopBrainSemanticIndex } from './service.js'
const page = (patch: Partial<DesktopBrainSemanticPage> = {}): DesktopBrainSemanticPage => ({ slug: 'pricing', title: 'Pricing', type: 'offering', hash: 'a'.repeat(32), content: '## Overview\n\nOur pricing is public.', sources: [], unconfirmed: [], links: [], updatedAt: '', updatedBy: 'user', ...patch })
function fixture(initial = [page()]) {
    let backend: DesktopBrainSemanticBackend | null = { model: 'embedding', version: '1', dimensions: 2, revision: crypto.randomUUID() }
    let pages = initial
    const entries = new Map<string, DesktopBrainSemanticIndexEntry>(), pending = new Map<string, DesktopBrainSemanticPending>()
    const embedding = { identity: vi.fn(() => backend), embed: vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0])) }
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
describe('desktop Brain semantic authority and derived index', () => {
    it('returns semantic passages without shared keywords after explicit maintenance', async () => {
        const f = fixture(), service = createDesktopBrainSemanticIndex(f.ports)
        expect((await service.status()).mode).toBe('partial')
        expect(f.embedding.embed).not.toHaveBeenCalled()
        await service.reconcile(true)
        const result = await service.search({ query: 'commercial transparency' })
        expect(result.hits[0]).toMatchObject({ slug: 'pricing', passages: [{ heading: 'Overview', content: 'Our pricing is public.' }] })
        expect(result.index.mode).toBe('ready')
    })
    it('keeps keyword results while the configured provider is offline', async () => {
        const f = fixture(), service = createDesktopBrainSemanticIndex(f.ports)
        await service.reconcile(true)
        f.embedding.embed.mockRejectedValue(new Error('offline'))
        f.ports.pages.search = vi.fn(async () => ({ hits: [{ slug: 'pricing', title: 'Pricing', type: 'offering', score: 1, passages: [{ heading: 'Overview', content: 'Our pricing is public.' }] }], related: [] }))
        const result = await service.search({ query: 'pricing' })
        expect(result.hits).toHaveLength(1)
        expect(result.index.mode).toBe('partial')
        expect(result.index.message).toContain('unavailable')
    })
    it('does not publish changed-page vectors and queues the current page on the next maintenance', async () => {
        const f = fixture(), service = createDesktopBrainSemanticIndex(f.ports)
        f.embedding.embed.mockImplementation(async texts => { f.setPages([page({ hash: 'd'.repeat(32), content: '## Overview\n\nNew pricing.' })]); return texts.map(() => [1, 0]) })
        await service.reconcile(true)
        expect(f.entries.size).toBe(0)
        await service.reconcile(false)
        expect([...f.pending.values()].map(p => p.pageHash)).toEqual(['d'.repeat(32)])
    })
    it('retains exact pending identities and retry counts across reconciliation', async () => {
        const f = fixture(), service = createDesktopBrainSemanticIndex(f.ports)
        await service.reconcile(false)
        const old = [...f.pending.values()][0]
        f.pending.set(old.chunk.id, { ...old, attempts: 2 })
        await service.reconcile(false)
        expect([...f.pending.values()]).toEqual([{ ...old, attempts: 2 }])
        expect(f.embedding.embed).not.toHaveBeenCalled()
    })
    it('refuses late publication after Stop even if embedding ignores cancellation', async () => {
        const f = fixture(), service = createDesktopBrainSemanticIndex(f.ports), stop = new AbortController()
        let resolve!: (vectors: number[][]) => void, entered!: () => void
        const started = new Promise<void>(r => { entered = r })
        f.embedding.embed.mockImplementation(() => new Promise(r => { resolve = r; entered() }))
        const work = service.reconcile(true, stop.signal)
        await started; stop.abort(new Error('Stopped'))
        await expect(work).rejects.toThrow('Stopped')
        resolve([[1, 0]]); await Promise.resolve()
        expect(f.entries.size).toBe(0)
    })
    it('does not publish vectors under a rotated credential identity', async () => {
        const f = fixture(), service = createDesktopBrainSemanticIndex(f.ports)
        f.embedding.embed.mockImplementation(async texts => { f.setBackend({ model: 'other', version: '1', dimensions: 2, revision: crypto.randomUUID() }); return texts.map(() => [1, 0]) })
        await service.reconcile(true)
        expect(f.entries.size).toBe(0)
    })
    it('removes deleted pages and excludes them from search', async () => {
        const f = fixture(), service = createDesktopBrainSemanticIndex(f.ports)
        await service.reconcile(true); f.setPages([])
        expect((await service.search({ query: 'pricing' })).hits).toEqual([])
        await service.reconcile(false)
        expect(f.entries.size).toBe(0)
    })
    it('includes one-hop backlinks as well as outgoing links', async () => {
        const f = fixture([page(), page({ slug: 'customer', title: 'Customer', hash: 'b'.repeat(32), content: '', links: ['pricing'] })])
        const service = createDesktopBrainSemanticIndex(f.ports); await service.reconcile(true)
        expect((await service.search({ query: 'pricing' })).related).toEqual([{ slug: 'customer', title: 'Customer' }])
    })
})
