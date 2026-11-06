import { createHash, randomUUID } from 'node:crypto'
import {
    DESKTOP_BRAIN_SEMANTIC_BATCH_MAX,
    DESKTOP_BRAIN_SEMANTIC_PASSAGES_PER_PAGE,
    DESKTOP_BRAIN_SEMANTIC_RELATED_MAX,
    DESKTOP_BRAIN_SEMANTIC_RRF_K,
    desktopBrainSemanticSearchInputSchema,
    type DesktopBrainSemanticBackend,
    type DesktopBrainSemanticHit,
    type DesktopBrainSemanticIndexEntry,
    type DesktopBrainSemanticIndexStatus,
    type DesktopBrainSemanticPending,
    type DesktopBrainSemanticPage,
    type DesktopBrainSemanticPorts,
    type DesktopBrainSemanticSearchResult,
} from '@rerun/contracts'
import { chunkPage } from '../../brain/chunks.js'
import { desktopSemanticCosine, desktopSemanticVector } from '../semantic-memory/vectors.js'

function fingerprint(backend: DesktopBrainSemanticBackend): string {
    return createHash('sha256').update(JSON.stringify(backend)).digest('hex')
}

function addRanked(scores: Map<string, number>, ids: readonly string[]): void {
    ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (DESKTOP_BRAIN_SEMANTIC_RRF_K + rank + 1))
}

function statusOf(entries: readonly DesktopBrainSemanticIndexEntry[], pending: readonly DesktopBrainSemanticPending[], backend: DesktopBrainSemanticBackend | null, message: string, omitted = 0): DesktopBrainSemanticIndexStatus {
    return {
        mode: !backend ? 'keyword-only' : message ? 'partial' : pending.length ? 'partial' : 'ready',
        backend,
        indexed: entries.length,
        pending: pending.length,
        omitted,
        message: message || (backend ? 'Semantic index is ready.' : 'Keyword search is available; no embedding service is configured.'),
    }
}

export function createDesktopBrainSemanticIndex(ports: DesktopBrainSemanticPorts) {
    async function currentEntries(backend: DesktopBrainSemanticBackend | null): Promise<DesktopBrainSemanticIndexEntry[]> {
        if (!backend) return []
        const current = fingerprint(backend)
        return (await ports.store.list()).filter(entry => entry.backendFingerprint === current && desktopSemanticVector(entry.vector, backend.dimensions))
    }

    async function desired(page: DesktopBrainSemanticPage, backend: DesktopBrainSemanticBackend, existing: readonly DesktopBrainSemanticIndexEntry[]): Promise<DesktopBrainSemanticPending[]> {
        const current = fingerprint(backend)
        return chunkPage(page).map(chunk => ({
            chunk: {
                id: existing.find(entry => entry.chunk.slug === chunk.slug && entry.chunk.ordinal === chunk.ordinal && entry.chunk.textHash === chunk.textHash)?.chunk.id ?? randomUUID(),
                slug: chunk.slug,
                heading: chunk.heading,
                ordinal: chunk.ordinal,
                content: chunk.content,
                textHash: chunk.textHash,
                text: chunk.text,
            },
            pageHash: page.hash,
            backendFingerprint: current,
            attempts: 0,
        }))
    }

    async function reconcile(embed = false): Promise<DesktopBrainSemanticIndexStatus> {
        await ports.authority(new AbortController().signal)
        const backend = ports.embedding.identity()
        const pages = await ports.pages.list()
        const existing = await ports.store.list()
        const pending = await ports.store.pending()
        const wanted = backend ? await Promise.all(pages.map(page => desired(page, backend, existing)) : []
        const wantedIds = new Set(wanted.flat().map(item => item.chunk.id)
        const stale = [...new Set([
            ...existing.filter(entry => !wantedIds.has(entry.chunk.id)).map(entry => entry.chunk.id),
            ...pending.filter(item => !wantedIds.has(item.chunk.id)).map(item => item.chunk.id),
        ])]
        if (stale.length) {
            await ports.store.remove(stale)
            await ports.store.removePending(stale)
        }
        if (!backend) return statusOf([], [], null, '', stale.length)
        const queued = wanted.flat().filter(item => !existing.some(entry => entry.chunk.id === item.chunk.id && entry.pageHash === item.pageHash && entry.chunk.textHash === item.chunk.textHash && entry.backendFingerprint === item.backendFingerprint))
        for (const item of queued) await ports.store.queue(item)
        if (embed) await embedPending(backend)
        return statusOf(await currentEntries(backend), await ports.store.pending(), backend, '', stale.length + queued.length)
    }

    async function embedPending(backend: DesktopBrainSemanticBackend): Promise<void> {
        for (;;) {
            await ports.authority(new AbortController().signal)
            const pending = (await ports.store.pending()).filter(item => item.backendFingerprint === fingerprint(backend) && item.attempts < 3)
            if (!pending.length) return
            const batch = pending.slice(0, DESKTOP_BRAIN_SEMANTIC_BATCH_MAX)
            const vectors = await ports.embedding.embed(batch.map(item => item.chunk.text), new AbortController().signal, backend.revision)
            for (const [index, item] of batch.entries()) {
                const page = await ports.pages.read(item.chunk.slug)
                const vector = desktopSemanticVector(vectors[index], backend.dimensions)
                if (!page || page.hash !== item.pageHash || !vector) {
                    await ports.store.queue({ ...item, attempts: item.attempts + 1 })
                    continue
                }
                await ports.store.write({ chunk: item.chunk, pageHash: item.pageHash, backendFingerprint: item.backendFingerprint, vector })
                await ports.store.removePending([item.chunk.id])
            }
            if (vectors.length !== batch.length) return
        }
    }

    async function invalidate(slug: string, expectedHash?: string): Promise<void> {
        if (expectedHash) {
            const page = await ports.pages.read(slug)
            if (!page || page.hash !== expectedHash) throw new Error('Brain page changed during indexing.')
        }
        await ports.store.removePage(slug)
        await ports.store.removePending((await ports.store.pending()).filter(item => item.chunk.slug === slug).map(item => item.chunk.id))
    }

    async function status(): Promise<DesktopBrainSemanticIndexStatus> {
        const backend = ports.embedding.identity()
        return statusOf(await currentEntries(backend), await ports.store.pending(), backend, '')
    }

    async function search(raw: unknown): Promise<DesktopBrainSemanticSearchResult> {
        const input = desktopBrainSemanticSearchInputSchema.parse(raw)
        await ports.authority(new AbortController().signal)
        const backend = ports.embedding.identity()
        const keyword = await ports.pages.search(input.query, input.limit)
        const entries = await currentEntries(backend)
        const scores = new Map<string, number>()
        const semanticPassages = new Map<string, { heading: string; content: string }>()
        let message = ''
        if (backend && entries.length) {
            try {
                const [queryVector] = await ports.embedding.embed([input.query], new AbortController().signal, backend.revision)
                const vector = desktopSemanticVector(queryVector, backend.dimensions)
                if (!vector) message = 'The embedding response was invalid. Keyword results are shown.'
                else {
                    const ranked = entries.filter(entry => desktopSemanticCosine(vector, entry.vector) !== null).sort((a, b) => (desktopSemanticCosine(vector, b.vector) ?? 0) - (desktopSemanticCosine(vector, a.vector) ?? 0))
                    addRanked(scores, ranked.map(entry => `${entry.chunk.slug}:${entry.chunk.heading}:${entry.chunk.content}`)
                    for (const entry of ranked) semanticPassages.set(`${entry.chunk.slug}:${entry.chunk.heading}:${entry.chunk.content}`, { heading: entry.chunk.heading, content: entry.chunk.content })
                }
            } catch {
                message = 'The embedding service is unavailable. Keyword results are shown.'
            }
        }
        const byChunk = new Map<string, number>()
        for (const hit of keyword.hits) for (const passage of hit.passages) byChunk.set(`${hit.slug}:${passage.heading}:${passage.content}`, Math.max(byChunk.get(`${hit.slug}:${passage.heading}:${passage.content}`) ?? 0, hit.score)
        for (const [index, id] of [...byChunk.keys()].entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (DESKTOP_BRAIN_SEMANTIC_RRF_K + index + 1))
        const pageBySlug = new Map(keyword.hits.map(hit => [hit.slug, hit]))
        const hits: DesktopBrainSemanticHit[] = []
        for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
            const semanticEntry = entries.find(entry => `${entry.chunk.slug}:${entry.chunk.heading}:${entry.chunk.content}` === id)
            const keywordHit = [...keyword.hits].find(hit => hit.passages.some(passage => `${hit.slug}:${passage.heading}:${passage.content}` === id)
            const slug = semanticEntry?.chunk.slug ?? keywordHit?.slug
            if (!slug) continue
            const page = await ports.pages.read(slug)
            if (!page || (semanticEntry && page.hash !== semanticEntry.pageHash) continue
            const passages = [...(semanticEntry ? [semanticPassages.get(id)!] : []), ...(keywordHit?.passages ?? [])]
            const existing = hits.find(hit => hit.slug === slug)
            if (existing) {
                existing.score = Math.max(existing.score, score)
                existing.passages.push(...passages.filter(passage => !existing.passages.some(current => current.heading === passage.heading && current.content === passage.content))
            } else {
                const keywordPage = pageBySlug.get(slug)
                hits.push({ slug, title: keywordPage?.title ?? page.title, type: keywordPage?.type ?? page.type, passages, score })
            }
            if (hits.length >= input.limit) break
        }
        for (const hit of hits) hit.passages = hit.passages.slice(0, DESKTOP_BRAIN_SEMANTIC_PASSAGES_PER_PAGE)
        const related = new Map<string, { slug: string; title: string }>()
        for (const item of keyword.related) {
            const page = await ports.pages.read(item.slug)
            if (page) related.set(item.slug, { slug: item.slug, title: page.title })
        }
        for (const hit of hits) {
            for (const slug of (await ports.pages.read(hit.slug))?.links ?? []) {
                if (hits.some(item => item.slug === slug) || related.has(slug) || related.size >= DESKTOP_BRAIN_SEMANTIC_RELATED_MAX) continue
                const page = await ports.pages.read(slug)
                if (page) related.set(slug, { slug, title: page.title })
            }
        }
        return { hits, related: [...related.values()], index: statusOf(entries, await ports.store.pending(), backend, message) }
    }

    return { reconcile, search, status, invalidate }
}
