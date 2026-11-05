import {
    DESKTOP_WEB_SEARCH_DEADLINE_MS,
    desktopWebSearchFingerprint,
    desktopWebSearchInputOf,
    desktopWebSearchOutcomeSchema,
    desktopWebSearchResponseSchema,
    type DesktopWebSearchCapabilityView,
    type DesktopWebSearchInvocationIdentity,
    type DesktopWebSearchOutcome,
    type DesktopWebSearchPorts,
    type DesktopWebSearchResponse,
    type DesktopWebSearchRunIdentity,
} from '@rerun/contracts'
import { abortable } from '../web-fetch/transport.js'
import { publicUrl } from '../web-fetch/public-url.js'

function normalize(value: string): string {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
}

function responseOf(value: unknown, maxResults: number): DesktopWebSearchResponse {
    const parsed = desktopWebSearchResponseSchema.safeParse(value)
    if (!parsed.success || parsed.data.results.length > maxResults) throw new Error('Search provider returned invalid results.')
    return {
        provenance: parsed.data.provenance,
        results: parsed.data.results.map(result => {
            const title = normalize(result.title).trim()
            if (!title) throw new Error('Search provider returned invalid results.')
            return {
                title,
                url: publicUrl(result.url).href,
                snippet: normalize(result.snippet),
            }
        }),
    }
}

function messageOf(error: unknown, fallback: string): string {
    const message = normalize(error instanceof Error ? error.message : fallback).trim()
    return (message || fallback).slice(0, 500)
}

export function createDesktopWebSearchService(ports: DesktopWebSearchPorts, options: { deadlineMs?: number } = {}) {
    const deadlineMs = options.deadlineMs ?? DESKTOP_WEB_SEARCH_DEADLINE_MS
    const active = new Map<string, Promise<DesktopWebSearchOutcome>>()
    const settled = new Map<string, DesktopWebSearchOutcome>()

    async function search(identity: DesktopWebSearchRunIdentity, input: unknown, parentSignal?: AbortSignal): Promise<DesktopWebSearchOutcome> {
        const parsed = desktopWebSearchInputOf(input)
        const deadline = new AbortController()
        const timer = setTimeout(() => deadline.abort(new Error('Deadline exceeded')), deadlineMs)
        const cancel = () => deadline.abort(parentSignal?.reason ?? new Error('Cancelled'))
        parentSignal?.addEventListener('abort', cancel, { once: true })
        if (parentSignal?.aborted) cancel()
        try {
            const authorization = await abortable(ports.authority(identity, deadline.signal), deadline.signal)
            const invocation: DesktopWebSearchInvocationIdentity = { ...identity, adapterGeneration: authorization.adapterGeneration }
            const fingerprint = await desktopWebSearchFingerprint(invocation, parsed)
            const previous = settled.get(fingerprint)
            if (previous) return previous
            const pending = active.get(fingerprint)
            if (pending) return pending

            const work = (async (): Promise<DesktopWebSearchOutcome> => {
                let began = false
                let publishing = false
                let providerFailure = false
                try {
                    const existing = await abortable(ports.outcomes.begin(invocation, fingerprint), deadline.signal)
                    if (existing !== 'execute') return desktopWebSearchOutcomeSchema.parse(existing)
                    began = true
                    if (!ports.adapter || ports.adapter.generation !== authorization.adapterGeneration) {
                        const outcome: DesktopWebSearchOutcome = { status: 'unavailable', message: 'Web search is unavailable: no authorized search capability is configured.' }
                        await abortable(ports.outcomes.complete(invocation, fingerprint, outcome), deadline.signal).catch(() => undefined)
                        return outcome
                    }
                    providerFailure = true
                    const raw = await abortable(ports.adapter.search({ ...parsed, identity: invocation, signal: deadline.signal }), deadline.signal)
                    const response = responseOf(raw, parsed.maxResults)
                    providerFailure = false
                    const current = await abortable(ports.authority(identity, deadline.signal), deadline.signal)
                    if (current.adapterGeneration !== authorization.adapterGeneration) throw new Error('Search capability changed.')
                    const outcome: DesktopWebSearchOutcome = { status: 'success', ...response }
                    publishing = true
                    await abortable(ports.outcomes.complete(invocation, fingerprint, outcome), deadline.signal)
                    deadline.signal.throwIfAborted()
                    return outcome
                } catch (error) {
                    const outcome: DesktopWebSearchOutcome = publishing
                        ? { status: 'uncertain', message: 'Search acknowledgement is unavailable. The search was not repeated.' }
                        : parentSignal?.aborted
                            ? { status: 'cancelled', message: 'Search cancelled by run.' }
                            : deadline.signal.aborted
                                ? { status: 'cancelled', message: `Search timed out after ${Math.round(deadlineMs / 1000)} s.` }
                                : { status: 'error', message: providerFailure ? 'Search provider failed.' : messageOf(error, 'Search is unavailable.') }
                    if (began) await ports.outcomes.complete(invocation, fingerprint, outcome).catch(() => undefined)
                    return outcome
                }
            })()
            active.set(fingerprint, work)
            try {
                const outcome = await work
                settled.set(fingerprint, outcome)
                return outcome
            } finally { active.delete(fingerprint) }
        } catch (error) {
            return parentSignal?.aborted
                ? { status: 'cancelled', message: 'Search cancelled by run.' }
                : deadline.signal.aborted
                    ? { status: 'cancelled', message: `Search timed out after ${Math.round(deadlineMs / 1000)} s.` }
                    : { status: 'error', message: messageOf(error, 'Search is unavailable.') }
        } finally {
            clearTimeout(timer)
            parentSignal?.removeEventListener('abort', cancel)
        }
    }

    async function readiness(signal: AbortSignal): Promise<DesktopWebSearchCapabilityView> {
        return ports.readiness(signal)
    }

    return { search, readiness }
}
