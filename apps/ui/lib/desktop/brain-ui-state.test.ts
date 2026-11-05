// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainUiRecord, BrainUiWrite } from './brain-ui-state-schema'
vi.mock('./draft-writes', () => ({ holdDraftAdmission: () => () => {}, subscribeDraftShutdown: () => () => {} }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('does not block quitting when Brain has never been opened', async () => {
    const client = await import('./brain-ui-state')
    expect(await client.flushBrainUiState()).toBe(true)
})
function server() {
    const rows = new Map<string, BrainUiRecord>()
    const receipts = new Map<string, string>()
    let loseNextAck = false
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
        if (options?.method === 'GET') {
            const key = new URL(String(_url), 'http://127.0.0.1').searchParams.get('key')
            return key === null ? Response.json({ records: [...rows.values()].filter(row => row.value !== null) })
                : Response.json(rows.get(key) ?? { key, revision: 0, value: null })
        }
        const input = JSON.parse(String(options?.body)) as BrainUiWrite
        const previous = rows.get(input.key) ?? { key: input.key, revision: 0, value: null }
        const fingerprint = JSON.stringify(input)
        if (receipts.has(input.requestId)) {
            if (receipts.get(input.requestId) !== fingerprint) return Response.json({ record: previous }, { status: 409 })
            return Response.json(previous)
        }
        if (input.baseRevision !== previous.revision) return Response.json({ record: previous }, { status: 409 })
        const next = { key: input.key, revision: previous.revision + 1, value: input.value }
        rows.set(input.key, next); receipts.set(input.requestId, fingerprint)
        if (loseNextAck) { loseNextAck = false; throw new Error('Persistence ACK lost') }
        return Response.json(next)
    })
    vi.stubGlobal('fetch', fetcher)
    return { rows, fetcher, loseAck: () => { loseNextAck = true } }
}
it('rehydrates pending intent from app storage after renderer restart on another origin', async () => {
    const backend = server()
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:41001' })
    const first = await import('./brain-ui-state')
    await first.hydrateBrainUiState()
    const intent = { requestId: 'engine-mutation-exact', input: { content: 'Keep this exact text' } }
    backend.loseAck()
    const dispatch = vi.fn()
    await expect(first.writeBrainUiState('intent:save:company', intent).then(dispatch)).rejects.toThrow('Persistence ACK lost')
    expect(dispatch).not.toHaveBeenCalled()
    vi.resetModules()
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:42002' })
    const restarted = await import('./brain-ui-state')
    await restarted.hydrateBrainUiState()
    expect(restarted.readBrainUiState('intent:save:company')).toEqual(intent)
    await restarted.writeBrainUiState('intent:save:company', intent)
    expect(backend.rows.get('intent:save:company')?.revision).toBe(1)
})
it('replays an ambiguous state write with identical CAS identity before a newer draft', async () => {
    const backend = server(), client = await import('./brain-ui-state')
    await client.hydrateBrainUiState()
    backend.loseAck()
    await expect(client.writeBrainUiState('new-page', { content: 'First' })).rejects.toThrow()
    await client.writeBrainUiState('new-page', { content: 'Second' })
    const puts = backend.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT').map(([, options]) => JSON.parse(String(options?.body)))
    expect(puts[1]).toEqual(puts[0])
    expect(puts[2]).toMatchObject({ baseRevision: 1, value: JSON.stringify({ content: 'Second' }) })
    expect(client.readBrainUiState('new-page')).toEqual({ content: 'Second' })
})
it('a competing persisted revision stops late writes instead of adopting and overwriting it', async () => {
    const backend = server(), client = await import('./brain-ui-state')
    await client.hydrateBrainUiState()
    backend.rows.set('new-page', { key: 'new-page', revision: 1, value: JSON.stringify({ content: 'Other window' }) })
    await expect(client.writeBrainUiState('new-page', { content: 'Stale' })).rejects.toThrow('another window')
    const count = backend.fetcher.mock.calls.length
    await expect(client.writeBrainUiState('new-page', { content: 'Still stale' })).rejects.toThrow()
    expect(backend.fetcher).toHaveBeenCalledTimes(count)
    expect(backend.rows.get('new-page')?.value).toContain('Other window')
    expect(await client.flushBrainUiState()).toBe(false)
})

it('hydrates only active state and obtains a cleared key revision lazily after restart', async () => {
    const backend = server()
    backend.rows.set('new-page', { key: 'new-page', revision: 9, value: null })
    const client = await import('./brain-ui-state')
    await client.hydrateBrainUiState()
    expect(client.readBrainUiState('new-page')).toBeNull()
    await client.writeBrainUiState('new-page', { content: 'Next page' })
    const puts = backend.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT').map(([, options]) => JSON.parse(String(options?.body)))
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ key: 'new-page', baseRevision: 9 })
    expect(backend.rows.get('new-page')?.revision).toBe(10)
})
it('coalesces simultaneous tombstone lookups before serializing newer writes', async () => {
    const backend = server(), client = await import('./brain-ui-state')
    backend.rows.set('new-page', { key: 'new-page', revision: 4, value: null })
    await client.hydrateBrainUiState()
    await Promise.all([client.writeBrainUiState('new-page', { content: 'First' }), client.writeBrainUiState('new-page', { content: 'Second' })])
    const lookups = backend.fetcher.mock.calls.filter(([url, options]) => options?.method === 'GET' && String(url).includes('?key='))
    expect(lookups).toHaveLength(1)
    const puts = backend.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT').map(([, options]) => JSON.parse(String(options?.body)))
    expect(puts.map(input => input.baseRevision)).toEqual([4, 5])
    expect(client.readBrainUiState('new-page')).toEqual({ content: 'Second' })
})
it('does not use a lazy lookup to overwrite an unseen active intent created after hydration', async () => {
    const backend = server(), client = await import('./brain-ui-state')
    await client.hydrateBrainUiState()
    backend.rows.set('intent:save:company', { key: 'intent:save:company', revision: 3, value: JSON.stringify({ requestId: 'other-window' }) })
    await expect(client.writeBrainUiState('intent:save:company', { requestId: 'new-window' })).rejects.toThrow('another window')
    expect(backend.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
    expect(backend.rows.get('intent:save:company')?.value).toContain('other-window')
})
