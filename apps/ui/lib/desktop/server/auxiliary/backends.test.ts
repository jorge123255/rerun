import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopAuxiliarySchema, desktopAuxiliaryStore } from './store'
import { desktopAuxiliaryBackends } from './backends'
import { desktopSearchOutcomes } from './search'
import { initializeDesktopRound44 } from '../round44-schema'

const dbs: ReturnType<typeof createClient>[] = []
const roots: string[] = []
afterEach(async () => {
    for (const db of dbs.splice(0)) db.close()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture({ durable = false } = {}) {
    let url = ':memory:'
    if (durable) {
        const root = await mkdtemp(join(tmpdir(), 'rerun-auxiliary-'))
        roots.push(root)
        url = pathToFileURL(join(root, 'app.db')).href
    }
    const db = createClient({ url }); dbs.push(db)
    await db.executeMultiple("CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE);"
        + "CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner');" + desktopAuxiliarySchema)
    const store = desktopAuxiliaryStore(db, () => Buffer.alloc(32, 8))
    return { db, store }
}
it('stores purpose-bound encrypted keys, preserves revisions, and rejects stale settings writes', async () => {
    const f = await fixture()
    await f.store.change({ purpose: 'search', expectedRevision: 'unconfigured', key: 'fixture-search-secret' })
    const row = (await f.db.execute('SELECT * FROM desktop_auxiliary_credentials')).rows[0]
    expect(JSON.stringify(row)).not.toContain('fixture-search-secret')
    expect(await desktopAuxiliaryStore(f.db, () => Buffer.alloc(32, 8)).read('search')).toEqual({ key: 'fixture-search-secret', revision: row.revision })
    expect(await f.store.read('embedding')).toEqual({ key: null, revision: 'unconfigured' })
    await expect(f.store.change({ purpose: 'search', expectedRevision: 'unconfigured', key: 'replacement' })).rejects.toThrow('changed')
    await f.db.execute({ sql: "INSERT INTO desktop_auxiliary_credentials VALUES('embedding',?,?)", args: [String(row.revision), String(row.ciphertext)] })
    await expect(f.store.read('embedding')).rejects.toThrow()
    await f.store.change({ purpose: 'search', expectedRevision: String(row.revision), key: '' })
    expect((await f.store.read('search')).key).toBeNull()
    expect(JSON.stringify(await f.store.list())).not.toContain('fixture-search-secret')
})

it('an unset backend performs no network request and never reads a chat login', async () => {
    const f = await fixture(), fetcher = vi.fn<typeof fetch>()
    const backends = desktopAuxiliaryBackends(f.store, fetcher)
    await expect(backends.search({ query: 'example', maxResults: 5 }, 'unconfigured', new AbortController().signal)).rejects.toThrow('not configured')
    await expect(backends.embed(['example'], new AbortController().signal)).rejects.toThrow('not configured')
    await expect(backends.transcribe(new Uint8Array([1]), 'webm', new AbortController().signal)).rejects.toThrow('not configured')
    expect(fetcher).not.toHaveBeenCalled()
})

it('Brave keeps provider ordering, bounded text, and refuses a result after key replacement', async () => {
    const f = await fixture()
    await f.store.change({ purpose: 'search', expectedRevision: 'unconfigured', key: 'fixture-key' })
    const revision = (await f.store.read('search')).revision
    let replace = false
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
        expect(String(url)).toBe('https://api.search.brave.com/res/v1/web/search?q=source&count=2')
        expect(options?.redirect).toBe('error')
        expect(new Headers(options?.headers).get('X-Subscription-Token')).toBe('fixture-key')
        if (replace) await f.store.change({ purpose: 'search', expectedRevision: revision, key: 'next-key' })
        return Response.json({ web: { results: [{ title: 'Second', url: 'https://example.com/2', description: 'x'.repeat(5000) }, { title: 'First', url: 'https://example.com/1' }] } })
    })
    const backends = desktopAuxiliaryBackends(f.store, fetcher), signal = new AbortController().signal
    const result = await backends.search({ query: 'source', maxResults: 2 }, revision, signal)
    expect(result.results.map(row => row.title)).toEqual(['Second', 'First'])
    expect(result.results[0].snippet.length).toBe(4000)
    replace = true
    await expect(backends.search({ query: 'source', maxResults: 2 }, revision, signal)).rejects.toThrow('changed')
})

it('requires a complete correctly indexed embedding batch and purpose-specific transcription key', async () => {
    const f = await fixture(), signal = new AbortController().signal
    await f.store.change({ purpose: 'embedding', expectedRevision: 'unconfigured', key: 'embed-key' })
    await f.store.change({ purpose: 'transcription', expectedRevision: 'unconfigured', key: 'voice-key' })
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
        if (String(url).endsWith('/embeddings')) {
            expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer embed-key')
            expect(JSON.parse(String(options?.body))).toMatchObject({ model: 'openai/text-embedding-3-small', encoding_format: 'float' })
            return Response.json({ data: [{ index: 1, embedding: Array(1536).fill(2) }, { index: 0, embedding: Array(1536).fill(1) }] })
        }
        expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer voice-key')
        return Response.json({ text: ' hello ' })
    })
    const backends = desktopAuxiliaryBackends(f.store, fetcher)
    expect((await backends.embed(['a', 'b'], signal)).map(row => row[0])).toEqual([1, 2])
    await expect(backends.embed(['one'], signal)).rejects.toThrow('incomplete')
    expect(await backends.transcribe(new Uint8Array([1, 2]), 'webm', signal)).toBe('hello')
})

it('search receipts survive a fresh service and never permit another effect or conflicting result', async () => {
    const f = await fixture(), store = desktopSearchOutcomes(f.db, 'owner')
    const identity = { agentId: 'engine-owner', sessionId: 'chat', runId: 'run', toolCallId: 'call', adapterGeneration: 'one' }
    expect(await store.begin(identity, 'fp')).toBe('execute')
    expect(await desktopSearchOutcomes(f.db, 'owner').begin(identity, 'fp')).toMatchObject({ status: 'uncertain' })
    await expect(store.begin({ ...identity, adapterGeneration: 'two' }, 'different')).rejects.toThrow()
    const outcome = { status: 'success' as const, provenance: { provider: 'brave' }, results: [] }
    await store.complete(identity, 'fp', outcome)
    expect(await store.begin(identity, 'fp')).toEqual(outcome)
    await expect(store.complete(identity, 'fp', { status: 'error', message: 'different' })).rejects.toThrow()
    await expect(desktopSearchOutcomes(f.db, 'other').begin(identity, 'fp')).rejects.toThrow()
})

it('search pre-flight revision mismatch is capability-changed without calling the provider', async () => {
    const f = await fixture(), fetcher = vi.fn<typeof fetch>()
    await f.store.change({ purpose: 'search', expectedRevision: 'unconfigured', key: 'fixture-key' })
    const backends = desktopAuxiliaryBackends(f.store, fetcher)
    await expect(backends.search({ query: 'stale', maxResults: 1 }, 'not-this-revision', new AbortController().signal)).rejects.toThrow('Search capability changed.')
    expect(fetcher).not.toHaveBeenCalled()
})

it('upgrades saved tool keys without changing their encrypted bytes or Brave revision', async () => {
    const { db, store } = await fixture({ durable: true })
    await store.change({ purpose: 'search', expectedRevision: 'unconfigured', key: 'prior-brave-key' })
    await store.change({ purpose: 'embedding', expectedRevision: 'unconfigured', key: 'prior-embedding-key' })
    const rows = (await db.execute('SELECT * FROM desktop_auxiliary_credentials ORDER BY purpose')).rows
    const original = await store.readSearch()
    await initializeDesktopRound44(db)
    await initializeDesktopRound44(db)
    expect((await db.execute('SELECT * FROM desktop_auxiliary_credentials ORDER BY purpose')).rows).toEqual(rows)
    expect(await store.readSearch()).toEqual(original)
    expect((await store.read('embedding')).key).toBe('prior-embedding-key')
    await store.change({ purpose: 'keirolabs-search', expectedRevision: 'unconfigured', key: 'fixture-keiro-key' })
    expect((await store.read('keirolabs-search')).key).toBe('fixture-keiro-key')
    expect(JSON.stringify(await store.list())).not.toContain('fixture-keiro-key')
})

it('uses the Keirolabs lite endpoint with a purpose-bound key and preserves ranked results', async () => {
    const { db, store } = await fixture({ durable: true })
    await initializeDesktopRound44(db)
    await store.change({ purpose: 'keirolabs-search', expectedRevision: 'unconfigured', key: 'fixture-keiro-key' })
    const { generation } = await store.readSearch()
    const fetcher = vi.fn<typeof fetch>(async (url, request) => {
        expect(String(url)).toBe('https://api.keirolabs.cloud/api/v2/search/lite')
        expect(request).toMatchObject({ method: 'POST', redirect: 'error', body: '{"query":"board fixture","maxResults":2}' })
        expect(new Headers(request?.headers).get('Authorization')).toBe('Bearer fixture-keiro-key')
        expect(new Headers(request?.headers).has('X-Subscription-Token')).toBe(false)
        return Response.json({ results: [
            { title: 'First source', url: 'https://example.com/first', snippet: 'fixture excerpt' },
            { url: null },
            { title: null, url: 'https://example.com/second', snippet: null },
        ] })
    })
    await expect(desktopAuxiliaryBackends(store, fetcher).search(
        { query: 'board fixture', maxResults: 2 }, generation, new AbortController().signal,
    )).resolves.toEqual({
        provenance: { provider: 'keirolabs' },
        results: [
            { title: 'First source', url: 'https://example.com/first', snippet: 'fixture excerpt' },
            { title: 'https://example.com/second', url: 'https://example.com/second', snippet: '' },
        ],
    })
    expect(fetcher).toHaveBeenCalledOnce()
})

it('uses Brave when both are configured and makes no second request after a provider failure', async () => {
    const { db, store } = await fixture({ durable: true })
    await initializeDesktopRound44(db)
    await store.change({ purpose: 'keirolabs-search', expectedRevision: 'unconfigured', key: 'fixture-keiro-key' })
    const earlier = await store.readSearch()
    await store.change({ purpose: 'search', expectedRevision: 'unconfigured', key: 'fixture-brave-key' })
    const { generation } = await store.readSearch()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }))
    const backend = desktopAuxiliaryBackends(store, fetcher)
    const input = { query: 'fixture', maxResults: 1 }, signal = new AbortController().signal
    await expect(backend.search(input, generation, signal)).rejects.toThrow('did not accept')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0][0])).toContain('https://api.search.brave.com/')
    const { revision } = await store.read('search')
    await store.change({ purpose: 'search', expectedRevision: revision, key: '' })
    expect((await store.readSearch()).credential?.provider).toBe('keirolabs')
    await expect(backend.search(input, earlier.generation, signal)).rejects.toThrow('Search capability changed.')
    expect(fetcher).toHaveBeenCalledOnce()
})

it('discards a Keirolabs result when the key is removed during the request', async () => {
    const { db, store } = await fixture({ durable: true })
    await initializeDesktopRound44(db)
    await store.change({ purpose: 'keirolabs-search', expectedRevision: 'unconfigured', key: 'fixture-keiro-key' })
    const { generation } = await store.readSearch()
    const { revision } = await store.read('keirolabs-search')
    const fetcher = vi.fn<typeof fetch>(async () => {
        await store.change({ purpose: 'keirolabs-search', expectedRevision: revision, key: '' })
        return Response.json({ results: [{ title: 'Stale', url: 'https://example.com' }] })
    })
    await expect(desktopAuxiliaryBackends(store, fetcher).search(
        { query: 'fixture', maxResults: 1 }, generation, new AbortController().signal,
    )).rejects.toThrow('Search capability changed after the provider request.')
    expect(fetcher).toHaveBeenCalledOnce()
    expect((await store.readSearch()).credential).toBeNull()
})
