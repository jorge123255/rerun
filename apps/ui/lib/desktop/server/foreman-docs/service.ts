import 'server-only'
import {
    DESKTOP_FOREMAN_DOCS_LIMITS,
    desktopForemanDocsRequestSchema,
    desktopForemanDocsResultSchema,
    type DesktopForemanDocsCorpus,
    type DesktopForemanDocsReceipt,
    type DesktopForemanDocsRequest,
    type DesktopForemanDocsResult,
    type DesktopForemanDocsSource,
} from '@rerun/contracts'
import type { DesktopForemanBinding } from '@rerun/contracts'
import { desktopForemanDocsBodyFingerprint, desktopForemanDocsCorpusFingerprint, desktopForemanDocsRequestFingerprint } from './identity'
import { desktopForemanDocsSectionTitle, parseDesktopForemanDocs, rankDesktopForemanDocs } from './search'
import type { DesktopForemanDocsFetchResult } from './fetch'

export type DesktopForemanDocsCorpusRecord = {
    corpus: DesktopForemanDocsCorpus
    fingerprint: string
    body: string
    fetchedAt: string
    sha256: string
    byteLength: number
    version: string
    publishedBy: { workspaceId: string; chatId: string; runId: string; toolCallId: string }
}

export type DesktopForemanDocsStore = {
    reserve(request: DesktopForemanDocsRequest, fingerprint: string, createdAt: string): Promise<{ receipt: DesktopForemanDocsReceipt; created: boolean }>
    finish(request: DesktopForemanDocsRequest, fingerprint: string, result: DesktopForemanDocsResult, updatedAt: string): Promise<DesktopForemanDocsReceipt>
    readCorpus(corpusId: string): Promise<DesktopForemanDocsCorpusRecord | null>
    publishCorpus(record: DesktopForemanDocsCorpusRecord, expectedFingerprint: string | null): Promise<void>
}

export type DesktopForemanDocsAuthorities = {
    store: DesktopForemanDocsStore
    fetchCorpus: (corpus: DesktopForemanDocsCorpus, signal: AbortSignal, assertLive: () => Promise<void>) => Promise<DesktopForemanDocsFetchResult>
    assertLive: (binding: DesktopForemanBinding, signal: AbortSignal) => Promise<void>
    now?: () => Date
}

export class DesktopForemanDocsLiveError extends Error {
    constructor() {
        super('This Foreman documentation run is no longer current.')
        this.name = 'DesktopForemanDocsLiveError'
    }
}

const interrupted = (request: DesktopForemanDocsRequest): DesktopForemanDocsResult => ({
    status: 'unavailable', documentation: request.corpus.documentation, passages: [], source: null,
    note: 'The documentation search was interrupted. Retry explicitly with a new request.',
})
const cancelled = (request: DesktopForemanDocsRequest): DesktopForemanDocsResult => ({
    status: 'cancelled', documentation: request.corpus.documentation, passages: [], source: null,
    note: 'The documentation search was cancelled. Retry explicitly with a new request.',
})
const unavailable = (request: DesktopForemanDocsRequest): DesktopForemanDocsResult => ({
    status: 'unavailable', documentation: request.corpus.documentation, passages: [], source: null,
    note: `The documentation could not be read (the public export is unavailable). Point the user at ${request.corpus.documentation} rather than answering from memory.`,
})

function validCache(record: DesktopForemanDocsCorpusRecord | null, corpus: DesktopForemanDocsCorpus): record is DesktopForemanDocsCorpusRecord {
    return !!record && record.fingerprint === desktopForemanDocsCorpusFingerprint(corpus) && record.byteLength === Buffer.byteLength(record.body) && record.byteLength > 0 && record.byteLength <= DESKTOP_FOREMAN_DOCS_LIMITS.maxCorpusBytes && record.sha256 === desktopForemanDocsBodyFingerprint(record.body) && Number.isFinite(Date.parse(record.fetchedAt))
}

function source(record: DesktopForemanDocsCorpusRecord, cacheState: DesktopForemanDocsSource['cacheState'], now: Date): DesktopForemanDocsSource {
    return { corpusId: record.corpus.id, sourceUrl: record.corpus.exportUrl, cacheState, fetchedAt: record.fetchedAt, ageMs: Math.max(0, now.getTime() - Date.parse(record.fetchedAt)), sha256: record.sha256, byteLength: record.byteLength, version: record.version }
}

function result(request: DesktopForemanDocsRequest, record: DesktopForemanDocsCorpusRecord, cacheState: DesktopForemanDocsSource['cacheState'], now: Date): DesktopForemanDocsResult {
    const sections = parseDesktopForemanDocs(record.body)
    if (!sections.length) throw new Error('The documentation export is empty.')
    const hits = rankDesktopForemanDocs(sections, request.query)
    const pages = [...new Map(sections.map(section => [section.page, { title: section.page.slice(0, 512), url: section.url.split('#')[0]! }])).values()]
    const limitedPages = pages.slice(0, DESKTOP_FOREMAN_DOCS_LIMITS.maxPages)
    const notes: string[] = []
    if (!hits.length) notes.push('Nothing in the documentation matched those words. Try another wording against the pages listed here, and never invent an answer.')
    if (pages.length > limitedPages.length) notes.push(`Only the first ${DESKTOP_FOREMAN_DOCS_LIMITS.maxPages} pages are listed.`)
    if (cacheState === 'stale') notes.push('The documentation could not be refreshed. These passages come from the cached copy identified here.')
    return desktopForemanDocsResultSchema.parse({
        status: hits.length ? 'ok' : 'empty',
        documentation: request.corpus.documentation,
        passages: hits.map(section => ({ title: desktopForemanDocsSectionTitle(section).slice(0, 600), url: section.url, text: section.body.slice(0, DESKTOP_FOREMAN_DOCS_LIMITS.passageChars) })),
        ...(hits.length ? {} : { pages: limitedPages }),
        ...(notes.length ? { note: notes.join(' ') } : {}),
        source: source(record, cacheState, now),
    })
}

export function createDesktopForemanDocsService(authorities: DesktopForemanDocsAuthorities) {
    const now = authorities.now ?? (() => new Date())
    const flights = new Map<string, Promise<DesktopForemanDocsResult>>()

    async function live(request: DesktopForemanDocsRequest, signal: AbortSignal) {
        signal.throwIfAborted()
        await authorities.assertLive(request.binding, signal)
        signal.throwIfAborted()
    }

    async function perform(request: DesktopForemanDocsRequest, fingerprint: string, signal: AbortSignal): Promise<DesktopForemanDocsResult> {
        try {
            const cached = await authorities.store.readCorpus(request.corpus.id)
            await live(request, signal)
            const usable = validCache(cached, request.corpus) ? cached : null
            if (usable && now().getTime() - Date.parse(usable.fetchedAt) < DESKTOP_FOREMAN_DOCS_LIMITS.corpusTtlMs) {
                let cachedResult: DesktopForemanDocsResult
                try {
                    cachedResult = result(request, usable, 'fresh', now())
                } catch {
                    cachedResult = unavailable(request)
                }
                if (cachedResult.status !== 'unavailable') return await finish(request, fingerprint, cachedResult, signal)
            }

            let record: DesktopForemanDocsCorpusRecord
            try {
                const deadline = AbortSignal.any([signal, AbortSignal.timeout(DESKTOP_FOREMAN_DOCS_LIMITS.fetchTimeoutMs)])
                const fetched = await authorities.fetchCorpus(request.corpus, deadline, () => live(request, signal))
                signal.throwIfAborted()
                if (deadline.aborted) throw new Error('Documentation fetch timed out.')
                const byteLength = Buffer.byteLength(fetched.body)
                if (fetched.byteLength !== byteLength || byteLength <= 0 || byteLength > DESKTOP_FOREMAN_DOCS_LIMITS.maxCorpusBytes) throw new Error('Documentation export exceeds its byte limit.')
                const sha256 = desktopForemanDocsBodyFingerprint(fetched.body)
                record = {
                    corpus: request.corpus,
                    fingerprint: desktopForemanDocsCorpusFingerprint(request.corpus),
                    body: fetched.body,
                    fetchedAt: now().toISOString(),
                    sha256,
                    byteLength,
                    version: fetched.version || sha256,
                    publishedBy: { workspaceId: request.binding.workspaceId, chatId: request.binding.chatId, runId: request.binding.runId, toolCallId: request.toolCallId },
                }
                result(request, record, 'revalidated', now())
            } catch (error) {
                if (error instanceof DesktopForemanDocsLiveError || signal.aborted) throw error
                let fallback = unavailable(request)
                if (usable) {
                    try { fallback = result(request, usable, 'stale', now()) } catch { /* An invalid cache cannot become evidence. */ }
                }
                return await finish(request, fingerprint, fallback, signal)
            }

            await live(request, signal)
            await authorities.store.publishCorpus(record, cached?.fingerprint ?? null)
            await live(request, signal)
            return await finish(request, fingerprint, result(request, record, 'revalidated', now()), signal)
        } catch (error) {
            if (signal.aborted) await authorities.store.finish(request, fingerprint, cancelled(request), now().toISOString()).catch(() => null)
            throw error
        }
    }

    async function finish(request: DesktopForemanDocsRequest, fingerprint: string, value: DesktopForemanDocsResult, signal: AbortSignal): Promise<DesktopForemanDocsResult> {
        await live(request, signal)
        const receipt = await authorities.store.finish(request, fingerprint, value, now().toISOString())
        await live(request, signal)
        return receipt.result!
    }

    return {
        async search(raw: DesktopForemanDocsRequest, signal: AbortSignal): Promise<DesktopForemanDocsResult> {
            const request = desktopForemanDocsRequestSchema.parse(raw)
            const fingerprint = desktopForemanDocsRequestFingerprint(request)
            await live(request, signal)
            const { receipt, created } = await authorities.store.reserve(request, fingerprint, now().toISOString())
            if (!created) {
                await live(request, signal)
                if (receipt.result) return receipt.result
                const flight = flights.get(request.toolCallId)
                if (flight) return flight
                return (await authorities.store.finish(request, fingerprint, interrupted(request), now().toISOString())).result!
            }
            const flight = perform(request, fingerprint, signal)
            flights.set(request.toolCallId, flight)
            try {
                return await flight
            } finally {
                if (flights.get(request.toolCallId) === flight) flights.delete(request.toolCallId)
            }
        },
    }
}

export type DesktopForemanDocsService = ReturnType<typeof createDesktopForemanDocsService>
