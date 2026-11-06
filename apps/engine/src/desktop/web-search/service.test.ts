import { describe, expect, it, vi } from 'vitest'
import type { DesktopWebSearchOutcome, DesktopWebSearchPorts, DesktopWebSearchResult } from '@rerun/contracts'
import { createDesktopWebSearchService } from './service'

const result = (patch: Partial<DesktopWebSearchResult> = {}): DesktopWebSearchResult => ({ title: 'One', url: 'https://one.example/', snippet: 'first', ...patch })
const success = (results = [result()]): DesktopWebSearchOutcome => ({ status: 'success', provenance: { provider: 'fixture-search' }, results })
const identity = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool-call' }
const invoke = (service: ReturnType<typeof createDesktopWebSearchService>, input: unknown) => service.search(identity, input)

function fixture(patch: {
    adapter?: DesktopWebSearchPorts['adapter'] | null
    authority?: DesktopWebSearchPorts['authority']
    begin?: DesktopWebSearchPorts['outcomes']['begin']
    complete?: DesktopWebSearchPorts['outcomes']['complete']
} = {}) {
    const adapter = patch.adapter === undefined ? {
        generation: 'generation-1',
        search: vi.fn(async () => ({ provenance: { provider: 'fixture-search' }, results: [result()] })),
    } : patch.adapter
    const authority = patch.authority ?? vi.fn(async () => ({ adapterGeneration: 'generation-1' }))
    const outcomes = {
        begin: patch.begin ?? vi.fn(async () => 'execute' as const),
        complete: patch.complete ?? vi.fn(async () => {}),
    }
    const readiness = vi.fn(async () => ({ status: 'ready' as const, message: 'Search is ready.', retryable: false }))
    return { adapter, authority, outcomes, readiness }
}

function portsOf(parts: ReturnType<typeof fixture>): DesktopWebSearchPorts {
    return { adapter: parts.adapter, authority: parts.authority, outcomes: parts.outcomes, readiness: parts.readiness }
}

describe('desktop web search service', () => {
    it('uses original defaults and preserves provider ranking and provenance', async () => {
        const parts = fixture()
        parts.adapter!.search = vi.fn(async () => ({ provenance: { provider: 'fixture-search' }, results: [result(), result({ title: 'Two', url: 'https://two.example/', snippet: '' }) ] }))
        const service = createDesktopWebSearchService(portsOf(parts))
        await expect(invoke(service, { query: 'a & b' })).resolves.toEqual(success([result(), result({ title: 'Two', url: 'https://two.example/', snippet: '' })]))
        expect(parts.adapter!.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'a & b', maxResults: 5 }))
    })

    it('returns an acknowledged empty result only after a successful backend response', async () => {
        const parts = fixture()
        parts.adapter!.search = vi.fn(async () => ({ provenance: { provider: 'fixture-search' }, results: [] }))
        const service = createDesktopWebSearchService(portsOf(parts))
        await expect(invoke(service, { query: 'nothing' })).resolves.toEqual(success([]))
    })

    it('fails unavailable without an adapter and never presents that as empty success', async () => {
        const parts = fixture({ adapter: null })
        const service = createDesktopWebSearchService(portsOf(parts))
        const outcome = await invoke(service, { query: 'x' })
        expect(outcome).toMatchObject({ status: 'unavailable' })
        expect(outcome).not.toMatchObject({ status: 'success' })
    })

    it.each([
        ['too many rows', { provenance: { provider: 'fixture-search' }, results: [result(), result({ title: 'Two', url: 'https://two.example/' })] }],
        ['bad URL', { provenance: { provider: 'fixture-search' }, results: [result({ url: 'file:///tmp/private' })] }],
        ['local URL', { provenance: { provider: 'fixture-search' }, results: [result({ url: 'http://localhost:3000/private' })] }],
        ['bad provenance', { provenance: { provider: 'https://internal.example/' }, results: [result()] }],
        ['missing title', { provenance: { provider: 'fixture-search' }, results: [result({ title: '' })] }],
        ['control-only title', { provenance: { provider: 'fixture-search' }, results: [result({ title: String.fromCharCode(0) })] }],
    ])('rejects a malformed provider response: %s', async (_name, response) => {
        const parts = fixture()
        parts.adapter!.search = vi.fn(async () => response)
        const service = createDesktopWebSearchService(portsOf(parts))
        await expect(invoke(service, { query: 'x', maxResults: 1 })).resolves.toMatchObject({ status: 'error' })
    })

    it('redacts provider authorization errors and internal endpoints', async () => {
        const parts = fixture()
        parts.adapter!.search = vi.fn(async () => { throw new Error('401 at https://internal.example/private?token=secret') })
        const service = createDesktopWebSearchService(portsOf(parts))
        const outcome = await invoke(service, { query: 'x' })
        expect(outcome).toMatchObject({ status: 'error', message: 'Search provider failed.' })
        expect(JSON.stringify(outcome)).not.toContain('internal.example')
        expect(JSON.stringify(outcome)).not.toContain('token=secret')
    })

    it('cancels the complete operation at the injected deadline', async () => {
        const parts = fixture()
        parts.adapter!.search = vi.fn((_input) => new Promise((_resolve, reject) => {
            _input.signal.addEventListener('abort', () => reject(_input.signal.reason), { once: true })
        }))
        const service = createDesktopWebSearchService(portsOf(parts), { deadlineMs: 20 })
        await expect(invoke(service, { query: 'slow' })).resolves.toMatchObject({ status: 'cancelled', message: 'Search timed out after 0 s.' })
    })

    it('revalidates authority before publishing a provider result', async () => {
        const parts = fixture({ authority: vi.fn()
            .mockResolvedValueOnce({ adapterGeneration: 'generation-1' })
            .mockRejectedValueOnce(new Error('Permission revoked')) })
        const service = createDesktopWebSearchService(portsOf(parts))
        await expect(invoke(service, { query: 'x' })).resolves.toMatchObject({ status: 'error', message: 'Permission revoked' })
        expect(parts.outcomes.complete).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'success' }))
    })

    it('coalesces exact in-flight searches and refuses a conflicting identity', async () => {
        const parts = fixture()
        let release!: (value: { provenance: { provider: string }; results: DesktopWebSearchResult[] }) => void
        parts.adapter!.search = vi.fn(() => new Promise(resolve => { release = resolve }))
        const service = createDesktopWebSearchService(portsOf(parts))
        const first = invoke(service, { query: 'same' })
        const second = invoke(service, { query: 'same' })
        await vi.waitFor(() => expect(parts.adapter!.search).toHaveBeenCalledTimes(1))
        release({ provenance: { provider: 'fixture-search' }, results: [result()] })
        await expect(first).resolves.toEqual(success())
        await expect(second).resolves.toEqual(success())
    })

    it('does not issue another search after an uncertain acknowledgement', async () => {
        const parts = fixture({ complete: vi.fn().mockRejectedValueOnce(new Error('ack lost')).mockResolvedValueOnce(undefined) })
        const service = createDesktopWebSearchService(portsOf(parts))
        await expect(invoke(service, { query: 'x' })).resolves.toMatchObject({ status: 'uncertain' })
        await expect(invoke(service, { query: 'x' })).resolves.toMatchObject({ status: 'uncertain' })
        expect(parts.adapter!.search).toHaveBeenCalledTimes(1)
    })

    it('replays a retained outcome on restart with zero backend calls', async () => {
        const parts = fixture({ begin: vi.fn(async () => success()) })
        const service = createDesktopWebSearchService(portsOf(parts))
        await expect(invoke(service, { query: 'saved' })).resolves.toEqual(success())
        expect(parts.adapter!.search).not.toHaveBeenCalled()
    })

    it('surfaces conflicting begin identity without invoking the adapter', async () => {
        const parts = fixture({ begin: vi.fn(async () => { throw new Error('Invocation identity reused') }) })
        const service = createDesktopWebSearchService(portsOf(parts))
        await expect(invoke(service, { query: 'x' })).resolves.toMatchObject({ status: 'error', message: 'Invocation identity reused' })
        expect(parts.adapter!.search).not.toHaveBeenCalled()
    })

    it('prevents late adapter completion from publishing after cancellation', async () => {
        const parts = fixture()
        let finish!: (value: { provenance: { provider: string }; results: DesktopWebSearchResult[] }) => void
        parts.adapter!.search = vi.fn(() => new Promise(resolve => { finish = resolve }))
        const service = createDesktopWebSearchService(portsOf(parts), { deadlineMs: 10 })
        const outcome = await invoke(service, { query: 'late' })
        expect(outcome).toMatchObject({ status: 'cancelled' })
        finish({ provenance: { provider: 'fixture-search' }, results: [result()] })
        await Promise.resolve()
        expect(parts.outcomes.complete).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'success' }))
    })
    it('bounds failed-outcome cleanup after Stop even when storage never settles', async () => {
        const stop = new AbortController()
        const parts = fixture({ complete: vi.fn(() => new Promise(() => {})) })
        parts.adapter!.search = vi.fn(async () => { stop.abort(); throw new Error('stopped') })
        const service = createDesktopWebSearchService(portsOf(parts), { deadlineMs: 100, settlementMs: 15 })
        await expect(service.search(identity, { query: 'cancel' }, stop.signal)).resolves.toMatchObject({ status: 'cancelled' })
        expect(parts.outcomes.complete).toHaveBeenCalledTimes(1)
    })

    it('never races an uncertain success write with a second completion and recovers its receipt', async () => {
        let saved: DesktopWebSearchOutcome | undefined
        let finish!: () => void
        const parts = fixture({
            begin: vi.fn(async () => saved ?? 'execute'),
            complete: vi.fn((_identity, _fingerprint, outcome) => new Promise<void>(resolve => {
                finish = () => { saved = outcome; resolve() }
            })),
        })
        const service = createDesktopWebSearchService(portsOf(parts), { deadlineMs: 25, settlementMs: 10 })
        await expect(invoke(service, { query: 'pending receipt' })).resolves.toMatchObject({ status: 'uncertain' })
        expect(parts.outcomes.complete).toHaveBeenCalledTimes(1)
        await expect(invoke(service, { query: 'pending receipt' })).resolves.toMatchObject({ status: 'uncertain' })
        finish()
        await expect(invoke(service, { query: 'pending receipt' })).resolves.toEqual(success())
        expect(parts.adapter!.search).toHaveBeenCalledTimes(1)
        expect(parts.outcomes.complete).toHaveBeenCalledTimes(1)
    })

})
