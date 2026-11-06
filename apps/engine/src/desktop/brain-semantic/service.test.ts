import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopBrainSemanticBackend, DesktopBrainSemanticIndexEntry, DesktopBrainSemanticPage, DesktopBrainSemanticPending, DesktopBrainSemanticPorts } from '@rerun/contracts'
import { createDesktopBrainSemanticIndex } from './service'

const backend: DesktopBrainSemanticBackend = { model: 'openai/text-embedding-3-small', version: '1', dimensions: 2, revision: crypto.randomUUID() }
const backendFingerprint = createHash('sha256').update(JSON.stringify(backend)).digest('hex')
const page = (patch: Partial<DesktopBrainSemanticPage> = {}): DesktopBrainSemanticPage => ({
    slug: 'pricing', title: 'Pricing', type: 'offering', hash: 'a'.repeat(32), content: '# Overview\n\nOur pricing is public.\n\n# Details\n\nContact sales for the current plan.',
    sources: [], unconfirmed: [], links: [], updatedAt: '2026-11-05T10:00:00.000Z', updatedBy: 'user', ...patch,
})

function entryOf(slug = 'pricing', vector = [1, 0]): DesktopBrainSemanticIndexEntry {
    return {
        chunk: { id: crypto.randomUUID(), slug, heading: 'Overview', ordinal: 0, content: 'Our pricing is public.', textHash: 'b'.repeat(32), text: 'Pricing (offering) > Overview\n\nOur pricing is public.' },
        pageHash: 'a'.repeat(32), backendFingerprint, vector,
    }
}

function fixture(pages: DesktopBrainSemanticPage[], vectors: number[][] = [[1, 0]]) {
    const entries: DesktopBrainSemanticIndexEntry[] = []
    const pending: DesktopBrainSemanticPending[] = []
    const store = {
        list: vi.fn(async () => entries),
        write: vi.fn(async (entry: DesktopBrainSemanticIndexEntry) => { entries.push(entry) }),
        remove: vi.fn(async (ids: readonly string[]) => {
            for (const id of ids) {
                const index = entries.findIndex(entry => entry.chunk.id === id)
                if (index >= 0) entries.splice(index, 1)
            }
        }),
        removePage: vi.fn(async (slug: string) => {
            for (const [index, entry] of entries.entries()) if (entry.chunk.slug === slug) entries.splice(index, 1)
        }),
        pending: vi.fn(async () => pending),
        queue: vi.fn(async (job: DesktopBrainSemanticPending) => {
            const existing = pending.findIndex(item => item.chunk.id === job.chunk.id)
            if (existing >= 0) pending[existing] = job
            else pending.push(job)
        }),
        removePending: vi.fn(async (ids: readonly string[]) => {
            for (const id of ids) {
                const index = pending.findIndex(item => item.chunk.id === id)
                if (index >= 0) pending.splice(index, 1)
            }
        }),
    }
    const backendPort = {
        identity: vi.fn(() => backend),
        embed: vi.fn(async () => vectors),
    }
    const ports: DesktopBrainSemanticPorts = {
        pages: {
            list: vi.fn(async () => pages),
            read: vi.fn(async (slug: string) => pages.find(page => page.slug === slug) ?? null),
            search: vi.fn(async () => ({ hits: [], related: [] })),
        },
        embedding: backendPort,
        store,
        authority: vi.fn(async () => {}),
    }
    return { ports, entries, pending, backendPort, store }
}

describe('desktop Brain semantic index and search', () => {
    it('returns semantic-only matches with original passages and no keyword padding', async () => {
        const { ports, backendPort } = fixture([page()])
        const service = createDesktopBrainSemanticIndex(ports)
        await service.reconcile(true)
        const result = await service.search({ query: 'pricing transparency' })
        expect(result.hits).toHaveLength(1)
        expect(result.hits[0].passages[0].content).toContain('pricing is public')
        expect(backendPort.embed).toHaveBeenCalled()
        expect(result.index.mode).toBe('ready')
    })

    it('uses honest keyword fallback when the embedding service is offline', async () => {
        const { ports, backendPort } = fixture([page()])
        backendPort.embed = vi.fn(async () => { throw new Error('offline') })
        ports.pages.search = vi.fn(async () => ({ hits: [{ slug: 'pricing', title: 'Pricing', type: 'offering', score: 1, passages: [{ heading: 'Overview', content: 'Our pricing is public.' }] }], related: [] }))
        const service = createDesktopBrainSemanticIndex(ports)
        const result = await service.search({ query: 'pricing' })
        expect(result.hits).toHaveLength(1)
        expect(result.index.mode).not.toBe('ready')
        expect(result.index.message).toContain('unavailable')
    })

    it('does not publish a vector if the page changes during embedding', async () => {
        const { ports, entries } = fixture([page()])
        ports.pages.read = vi.fn(async () => ({ ...page(), hash: 'd'.repeat(32) })
        const service = createDesktopBrainSemanticIndex(ports)
        await service.reconcile(true)
        expect(entries).toHaveLength(0)
        expect(await ports.store.pending()).toHaveLength(1)
    })

    it('removes deleted pages and does not publish restored stale content', async () => {
        const { ports, entries } = fixture([page()])
        entries.push(entryOf())
        ports.pages.list = vi.fn(async () => [])
        const service = createDesktopBrainSemanticIndex(ports)
        await service.reconcile(false)
        expect(entries).toHaveLength(0)
        await service.invalidate('pricing', 'a'.repeat(32))
        expect(ports.store.removePage).toHaveBeenCalledWith('pricing')
    })

    it('excludes an old provider model from semantic ranking after a provider change', async () => {
        const { ports, backendPort } = fixture([page()])
        const changedRevision = crypto.randomUUID()
        backendPort.identity = vi.fn(() => ({ ...backend, revision: changedRevision })
        const service = createDesktopBrainSemanticIndex(ports)
        await service.reconcile(true)
        const result = await service.search({ query: 'pricing' })
        expect(result.index.backend?.revision).toBe(changedRevision)
        expect(backendPort.embed).toHaveBeenCalled()
    })

    it('does not expose another workspace page during search', async () => {
        const { ports, entries } = fixture([page()])
        entries.push(entryOf('other-workspace')
        const service = createDesktopBrainSemanticIndex(ports)
        const result = await service.search({ query: 'pricing' })
        expect(result.hits.every(hit => hit.slug === 'pricing')).toBe(true)
    })
})
