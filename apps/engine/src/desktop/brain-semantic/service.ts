import { createHash } from 'node:crypto'
import {
    DESKTOP_BRAIN_SEMANTIC_BATCH_MAX, DESKTOP_BRAIN_SEMANTIC_PASSAGES_PER_PAGE,
    DESKTOP_BRAIN_SEMANTIC_RELATED_MAX, DESKTOP_BRAIN_SEMANTIC_RRF_K,
    desktopBrainSemanticSearchInputSchema,
    type DesktopBrainSemanticBackend, type DesktopBrainSemanticHit,
    type DesktopBrainSemanticIndexEntry, type DesktopBrainSemanticIndexStatus,
    type DesktopBrainSemanticPending, type DesktopBrainSemanticPage,
    type DesktopBrainSemanticPorts, type DesktopBrainSemanticSearchResult,
} from '@rerun/contracts'
import { chunkPage } from '../../brain/chunks.js'
import { desktopSemanticCosine, desktopSemanticVector } from '../semantic-memory/vectors.js'

function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Brain search cancelled')) }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort()
    })
}
const MAX_CHUNKS = 8192
const fingerprint = (value: DesktopBrainSemanticBackend) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const passageKey = (slug: string, heading: string, content: string) => JSON.stringify([slug, heading, content])
function chunkId(page: DesktopBrainSemanticPage, ordinal: number, textHash: string, backend: DesktopBrainSemanticBackend) {
    const h = createHash('sha256').update(JSON.stringify([page.slug, page.hash, ordinal, textHash, fingerprint(backend)])).digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function createDesktopBrainSemanticIndex(ports: DesktopBrainSemanticPorts) {
    async function authorize(signal: AbortSignal) { signal.throwIfAborted(); await ports.authority(signal); signal.throwIfAborted() }
    async function backendIs(backend: DesktopBrainSemanticBackend, signal: AbortSignal) {
        await authorize(signal)
        const next = await ports.embedding.identity()
        signal.throwIfAborted()
        return next !== null && fingerprint(next) === fingerprint(backend)
    }
    async function current(signal: AbortSignal) {
        await authorize(signal)
        let backend: DesktopBrainSemanticBackend | null = null, identityError = false
        try { backend = await ports.embedding.identity() } catch { signal.throwIfAborted(); await authorize(signal); identityError = true }
        const pages = await ports.pages.list()
        await authorize(signal)
        const all = await ports.store.list(), pending = await ports.store.pending()
        const bySlug = new Map(pages.map(page => [page.slug, page]))
        const entries = backend ? all.filter(entry => {
            const page = bySlug.get(entry.chunk.slug)
            if (!page || page.hash !== entry.pageHash) return false
            return entry.backendFingerprint === fingerprint(backend!)
                && desktopSemanticVector(entry.vector, backend!.dimensions) !== null
                && chunkPage(page).some(chunk => chunk.ordinal === entry.chunk.ordinal && chunk.textHash === entry.chunk.textHash)
        }) : []
        return { backend, pages, all, entries, pending, identityError }
    }
    function report(state: Awaited<ReturnType<typeof current>>, message = ''): DesktopBrainSemanticIndexStatus {
        const chunks = state.pages.reduce((n, page) => n + chunkPage(page).length, 0)
        const missing = Math.max(0, Math.min(chunks, MAX_CHUNKS) - state.entries.length)
        const pending = state.backend ? state.pending.filter(p => p.backendFingerprint === fingerprint(state.backend!)).length : 0
        return { mode: state.identityError ? 'unavailable' : !state.backend ? 'keyword-only' : message || missing || pending ? 'partial' : 'ready', backend: state.backend,
            indexed: state.entries.length, pending: state.backend ? Math.max(pending, missing) : 0, omitted: Math.max(0, chunks - MAX_CHUNKS),
            message: message || (state.identityError ? 'Embedding configuration is unavailable. Keyword results remain available.' : !state.backend ? 'Keyword search is available; no embedding service is configured.' : missing || pending ? 'Semantic indexing is incomplete. Keyword results remain available.' : 'Semantic index is ready.') }
    }
    async function reconcile(embed = false, signal: AbortSignal = new AbortController().signal): Promise<DesktopBrainSemanticIndexStatus> {
        const state = await current(signal)
        const { backend } = state
        if (state.identityError) return report(state)
        const wanted: DesktopBrainSemanticPending[] = []
        if (backend) for (const page of state.pages) for (const chunk of chunkPage(page)) {
            if (wanted.length >= MAX_CHUNKS) break
            const id = chunkId(page, chunk.ordinal, chunk.textHash, backend)
            wanted.push({ chunk: { ...chunk, id, slug: page.slug }, pageHash: page.hash, backendFingerprint: fingerprint(backend), attempts: state.pending.find(p => p.chunk.id === id)?.attempts ?? 0 })
        }
        const ids = new Set(wanted.map(p => p.chunk.id))
        const stale = [...new Set([...state.all, ...state.pending].filter(p => !ids.has(p.chunk.id)).map(p => p.chunk.id))]
        await authorize(signal)
        if (stale.length) { await ports.store.remove(stale); await ports.store.removePending(stale) }
        if (!backend) return report(await current(signal))
        if (!await backendIs(backend, signal)) return report(await current(signal), 'Embedding configuration changed. Keyword results remain available.')
        for (const item of wanted) {
            if (!state.entries.some(entry => entry.chunk.id === item.chunk.id) && !state.pending.some(p => p.chunk.id === item.chunk.id)) {
                await authorize(signal); await ports.store.queue(item)
            }
        }
        let message = ''
        if (embed) {
            const batch = (await ports.store.pending()).filter(p => p.backendFingerprint === fingerprint(backend) && p.attempts < 3).slice(0, DESKTOP_BRAIN_SEMANTIC_BATCH_MAX)
            if (batch.length) try {
                if (!await backendIs(backend, signal)) throw new Error('backend changed')
                const vectors = await waitFor(ports.embedding.embed(batch.map(p => p.chunk.text), signal, backend.revision), signal)
                await authorize(signal)
                if (!await backendIs(backend, signal)) throw new Error('backend changed')
                for (const [index, item] of batch.entries()) {
                    const page = await ports.pages.read(item.chunk.slug), vector = desktopSemanticVector(vectors[index], backend.dimensions)
                    await authorize(signal)
                    if (!page || page.hash !== item.pageHash) { await ports.store.removePending([item.chunk.id]); continue }
                    if (!vector || vectors.length !== batch.length) { await ports.store.queue({ ...item, attempts: item.attempts + 1 }); message = 'The embedding response was invalid. Keyword results remain available.'; continue }
                    if (!await backendIs(backend, signal)) throw new Error('backend changed')
                    await ports.store.write({ chunk: item.chunk, pageHash: item.pageHash, backendFingerprint: item.backendFingerprint, vector })
                    await ports.store.removePending([item.chunk.id])
                }
            } catch {
                signal.throwIfAborted(); await authorize(signal)
                message = 'The embedding service is unavailable or changed. Keyword results remain available.'
                for (const item of batch) await ports.store.queue({ ...item, attempts: Math.min(3, item.attempts + 1) })
            }
        }
        return report(await current(signal), message)
    }
    async function invalidate(slug: string, expectedHash?: string, signal: AbortSignal = new AbortController().signal) {
        await authorize(signal)
        if (expectedHash && (await ports.pages.read(slug))?.hash !== expectedHash) throw new Error('Brain page changed during indexing.')
        await authorize(signal)
        await ports.store.removePage(slug)
        await ports.store.removePending((await ports.store.pending()).filter(p => p.chunk.slug === slug).map(p => p.chunk.id))
    }
    async function status(signal: AbortSignal = new AbortController().signal) { return report(await current(signal)) }
    async function search(raw: unknown, signal: AbortSignal = new AbortController().signal): Promise<DesktopBrainSemanticSearchResult> {
        const input = desktopBrainSemanticSearchInputSchema.parse(raw), state = await current(signal)
        const keyword = await ports.pages.search(input.query, 10)
        await authorize(signal)
        const scores = new Map<string, number>(), passages = new Map<string, { slug: string; heading: string; content: string }>()
        const add = (slug: string, heading: string, content: string, rank: number) => {
            const key = passageKey(slug, heading, content)
            passages.set(key, { slug, heading, content }); scores.set(key, (scores.get(key) ?? 0) + 1 / (DESKTOP_BRAIN_SEMANTIC_RRF_K + rank + 1))
        }
        let message = ''
        if (state.backend && state.entries.length) try {
            const [rawVector] = await waitFor(ports.embedding.embed([input.query], signal, state.backend.revision), signal)
            await authorize(signal)
            const vector = desktopSemanticVector(rawVector, state.backend.dimensions)
            if (!vector || !await backendIs(state.backend, signal)) throw new Error('invalid or changed')
            state.entries.map(entry => ({ entry, score: desktopSemanticCosine(vector, entry.vector) })).filter(v => v.score !== null)
                .sort((a, b) => b.score! - a.score!).slice(0, input.limit * 4).forEach(({ entry }, rank) => add(entry.chunk.slug, entry.chunk.heading, entry.chunk.content, rank))
        } catch {
            signal.throwIfAborted(); await authorize(signal)
            message = 'The embedding service is unavailable or changed. Keyword results are shown.'
        }
        let rank = 0
        for (const hit of keyword.hits) for (const p of hit.passages) add(hit.slug, p.heading, p.content, rank++)
        const hits: DesktopBrainSemanticHit[] = []
        for (const [key, score] of [...scores].sort((a, b) => b[1] - a[1])) {
            const passage = passages.get(key)!, page = await ports.pages.read(passage.slug)
            await authorize(signal)
            if (!page || !chunkPage(page).some(c => c.heading === passage.heading && c.content === passage.content)) continue
            let hit = hits.find(h => h.slug === page.slug)
            if (!hit) { if (hits.length >= input.limit) continue; hit = { slug: page.slug, title: page.title, type: page.type, score, passages: [] }; hits.push(hit) }
            if (hit.passages.length < DESKTOP_BRAIN_SEMANTIC_PASSAGES_PER_PAGE) hit.passages.push({ heading: passage.heading, content: passage.content })
        }
        const selected = new Set(hits.map(h => h.slug)), related = new Map<string, { slug: string; title: string }>()
        for (const page of await ports.pages.list()) {
            if (selected.has(page.slug)) continue
            if (page.links.some(slug => selected.has(slug)) || state.pages.some(source => selected.has(source.slug) && source.links.includes(page.slug))) related.set(page.slug, { slug: page.slug, title: page.title })
        }
        await authorize(signal)
        return { hits, related: [...related.values()].sort((a, b) => a.title.localeCompare(b.title)).slice(0, DESKTOP_BRAIN_SEMANTIC_RELATED_MAX), index: report(await current(signal), message) }
    }
    return { reconcile, search, status, invalidate }
}
