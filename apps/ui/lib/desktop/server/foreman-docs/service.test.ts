import { expect, it, vi } from 'vitest'
import { DESKTOP_FOREMAN_DOCS_LIMITS, RERUN_PUBLIC_DOCS_CORPUS, type DesktopForemanDocsReceipt, type DesktopForemanDocsRequest } from '@rerun/contracts'
import { createDesktopForemanDocsService, type DesktopForemanDocsCorpusRecord, type DesktopForemanDocsStore } from './service'
import { desktopForemanDocsCorpusFingerprint } from './identity'

const CORPUS = `# Automations
Source: https://docs.rerun.build/agents/automations

Make an agent run without you.

## Webhook triggers

A trigger gives an agent a public URL. Calling it starts a run. Rotate a leaked token.

# Billing
Source: https://docs.rerun.build/billing

## Credit

Every run spends credit. A trial workspace gets two dollars of credit.
`
const binding = { workspaceId: '1', chatId: 'fmc_chat-0001', runId: 'run-1', model: { connectionId: 'conn-1', model: 'model-a' } }
const input = (query = 'webhook token'): DesktopForemanDocsRequest => ({ binding, toolCallId: 'call-1', query, corpus: RERUN_PUBLIC_DOCS_CORPUS })
const fingerprint = desktopForemanDocsCorpusFingerprint(RERUN_PUBLIC_DOCS_CORPUS)

function cache(overrides: Partial<DesktopForemanDocsCorpusRecord> = {}): DesktopForemanDocsCorpusRecord {
    return { corpus: RERUN_PUBLIC_DOCS_CORPUS, fingerprint, body: CORPUS, fetchedAt: '2026-11-05T00:00:00.000Z', sha256: 'a'.repeat(64), byteLength: CORPUS.length, version: 'v1', publishedBy: { workspaceId: '1', chatId: binding.chatId, runId: binding.runId, toolCallId: 'old-call' }, ...overrides }
}

function harness(options: { cached?: DesktopForemanDocsCorpusRecord | null; fetchCorpus?: (corpus: DesktopForemanDocsRequest['corpus'], signal: AbortSignal) => Promise<{ body: string; byteLength: number; version: string }>; now?: Date } = {}) {
    const receipts = new Map<string, DesktopForemanDocsReceipt>()
    const published: DesktopForemanDocsCorpusRecord[] = []
    const store: DesktopForemanDocsStore = {
        async reserve(request, requestFingerprint, createdAt) {
            const previous = receipts.get(request.toolCallId)
            if (previous) {
                if (previous.fingerprint !== requestFingerprint || previous.request.binding.runId !== request.binding.runId) throw new Error('conflict')
                return { receipt: previous, created: false }
            }
            const receipt: DesktopForemanDocsReceipt = { request, fingerprint: requestFingerprint, status: 'pending', result: null, createdAt, updatedAt: createdAt }
            receipts.set(request.toolCallId, receipt)
            return { receipt, created: true }
        },
        async finish(request, requestFingerprint, result, updatedAt) {
            const previous = receipts.get(request.toolCallId)
            if (!previous || previous.fingerprint !== requestFingerprint) throw new Error('conflict')
            if (previous.result) return previous
            const receipt: DesktopForemanDocsReceipt = { ...previous, status: 'completed', result, updatedAt }
            receipts.set(request.toolCallId, receipt)
            return receipt
        },
        readCorpus: vi.fn(async () => options.cached === undefined ? null : options.cached),
        async publishCorpus(record, expectedFingerprint) {
            const current = options.cached === undefined ? null : options.cached
            if ((current?.fingerprint ?? null) !== expectedFingerprint) throw new Error('corpus changed')
            published.push(record)
            options.cached = record
        },
    }
    const fetchCorpus = vi.fn(options.fetchCorpus ?? (async () => ({ body: CORPUS, byteLength: CORPUS.length, version: 'v2' })))
    const now = options.now ?? new Date('2026-11-05T00:30:00.000Z')
    const service = createDesktopForemanDocsService({ store, fetchCorpus, assertLive: async (_binding, signal) => { signal.throwIfAborted() }, now: () => now })
    return { service, fetchCorpus, receipts, published, store }
}

it('returns four bounded passages at most, with exact source version and age', async () => {
    const { service, fetchCorpus } = harness()
    const result = await service.search(input(), new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(result.passages.length).toBeLessThanOrEqual(4)
    expect(result.passages.every(passage => passage.text.length <= 1600 && new URL(passage.url).origin === 'https://docs.rerun.build')).toBe(true)
    expect(result.source).toMatchObject({ cacheState: 'revalidated', version: 'v2', ageMs: 0 })
    expect(fetchCorpus).toHaveBeenCalledTimes(1)
})

it('uses a fresh cached corpus without network and reports an honest empty result', async () => {
    const { service, fetchCorpus } = harness({ cached: cache() })
    const result = await service.search(input('kubernetes'), new AbortController().signal)
    expect(result.status).toBe('empty')
    expect(result.pages?.map(page => page.title)).toEqual(['Automations', 'Billing'])
    expect(result.note).toContain('Nothing in the documentation matched those words')
    expect(result.source?.cacheState).toBe('fresh')
    expect(fetchCorpus).not.toHaveBeenCalled()
})

it('uses a stale cache offline with its real age, never remembered product behavior', async () => {
    const { service } = harness({ cached: cache(), now: new Date('2026-11-05T02:00:00.000Z'), fetchCorpus: async () => { throw new Error('offline') } })
    const result = await service.search(input(), new AbortController().signal)
    expect(result.status).toBe('ok')
    expect(result.source).toMatchObject({ cacheState: 'stale', ageMs: 7_200_000, version: 'v1' })
    expect(result.note).toContain('could not be refreshed')
})

it('returns the original documentation-home guidance when offline without a cache', async () => {
    const { service } = harness({ fetchCorpus: async () => { throw new Error('offline') } })
    const result = await service.search(input(), new AbortController().signal)
    expect(result.status).toBe('unavailable')
    expect(result.passages).toEqual([])
    expect(result.source).toBeNull()
    expect(result.documentation).toBe('https://docs.rerun.build')
    expect(result.note).toContain('rather than answering from memory')
})

it('recovers a completed same-ID receipt and refuses changed input without refetching', async () => {
    const { service, fetchCorpus } = harness()
    const first = await service.search(input(), new AbortController().signal)
    expect(await service.search(input(), new AbortController().signal)).toEqual(first)
    await expect(service.search(input('billing'), new AbortController().signal)).rejects.toThrow('conflict')
    expect(fetchCorpus).toHaveBeenCalledTimes(1)
})

it('rejects an interrupted oversized publication and retains the prior cache', async () => {
    const prior = cache()
    const { service, published } = harness({ cached: prior, now: new Date('2026-11-05T02:00:00.000Z'), fetchCorpus: async () => ({ body: CORPUS, byteLength: DESKTOP_FOREMAN_DOCS_LIMITS.maxCorpusBytes + 1, version: 'v3' }) })
    const result = await service.search(input(), new AbortController().signal)
    expect(result.source).toMatchObject({ cacheState: 'stale', version: 'v1' })
    expect(published).toHaveLength(0)
})

it('does not reuse cache belonging to a changed corpus identity', async () => {
    const changed = cache({ corpus: { ...RERUN_PUBLIC_DOCS_CORPUS, exportUrl: 'https://docs.rerun.build/other.txt' }, fingerprint: 'other' })
    const { service } = harness({ cached: changed, fetchCorpus: async () => { throw new Error('offline') } })
    const result = await service.search(input(), new AbortController().signal)
    expect(result.status).toBe('unavailable')
    expect(result.passages).toEqual([])
})

it('Stop blocks late publication and same-ID recovery returns the cancelled receipt without refetching', async () => {
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const { service, fetchCorpus, published } = harness({ fetchCorpus: async (_corpus, signal) => {
        markStarted()
        return new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason ?? new Error('cancelled'))
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
        })
    } })
    const controller = new AbortController()
    const pending = service.search(input(), controller.signal)
    await started
    controller.abort(new Error('Stop'))
    await expect(pending).rejects.toThrow()
    expect(published).toHaveLength(0)
    const recovered = await service.search(input(), new AbortController().signal)
    expect(recovered.status).toBe('cancelled')
    expect(fetchCorpus).toHaveBeenCalledTimes(1)
})
