'use client'

import {
    desktopServiceProgressResultSchema,
    desktopServiceRequestGuardSchema,
    desktopServiceRequestMutationSchema,
    desktopServiceRequestViewSchema,
    type DesktopServiceRequestGuard,
    type DesktopServiceRequestMutation,
    type DesktopServiceRequestView,
} from '@rerun/contracts'
import { createDurableServiceRequestRetryJournal, createServiceRequestRetryJournal, type ServiceRequestRetryStorage } from '@/components/desktop/service-requests/retry-journal'

import { DesktopServiceRequestRefused } from '@/components/desktop/service-requests/retry-journal'
export { DesktopServiceRequestRefused }

export type DesktopServiceRequestDetail = NonNullable<DesktopServiceRequestView['request']>
export type DesktopServiceRequestScope = {
    agentId: string
    sessionId: string
    serviceRequestId: string
    source: DesktopServiceRequestGuard
}
export type DesktopOpenApps = (input: {
    agentId: string
    slug: string
    serviceRequestId: string
    sourceFingerprint: string
    signal: AbortSignal
}) => Promise<{ status: 'closed' }>

export function serviceRequestScopeKey(scope: DesktopServiceRequestScope): string {
    return JSON.stringify([scope.agentId, scope.sessionId, scope.serviceRequestId, scope.source.sourceMessageId, scope.source.toolCallId, scope.source.fingerprint])
}

function sameSource(a: DesktopServiceRequestGuard, b: DesktopServiceRequestGuard): boolean {
    return a.sourceMessageId === b.sourceMessageId && a.toolCallId === b.toolCallId && a.fingerprint === b.fingerprint
}

export function assertServiceRequestDetail(scope: DesktopServiceRequestScope, detail: DesktopServiceRequestDetail): void {
    if (detail.serviceRequestId !== scope.serviceRequestId || !sameSource(detail.source, scope.source)
        || detail.currentIndex >= detail.services.length || detail.choices.length !== detail.services.length
        || detail.services.some((service, index) => service.slug !== detail.choices[index]?.slug)
        || new Set(detail.services.map(service => service.slug)).size !== detail.services.length) {
        throw new Error('This app request changed. Reload the conversation.')
    }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const limit = 2 * 1024 * 1024
    const size = response.headers.get('content-length')
    if (size && (!/^\d+$/.test(size) || Number(size) > limit)) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('App request response is too large.')
    }
    if (!response.body) throw new Error('App request response is unavailable.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let total = 0
    let text = ''
    const cancel = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        while (true) {
            signal.throwIfAborted()
            const part = await reader.read()
            signal.throwIfAborted()
            if (part.done) break
            total += part.value.byteLength
            if (total > limit) throw new Error('App request response is too large.')
            text += decoder.decode(part.value, { stream: true })
        }
        text += decoder.decode()
        return JSON.parse(text)
    } finally {
        signal.removeEventListener('abort', cancel)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
    }
}

export function createDesktopServiceRequestsClient(scopeInput: DesktopServiceRequestScope, storage?: ServiceRequestRetryStorage) {
    const scope: DesktopServiceRequestScope = { ...scopeInput, source: desktopServiceRequestGuardSchema.parse(scopeInput.source) }
    const url = `/api/desktop/sessions/${encodeURIComponent(scope.sessionId)}/service-requests`
    const lifetime = new AbortController()
    const finishControllers = new Set<AbortController>()
    let closed = false
    let mutating = false

    function parseMutation(value: unknown): DesktopServiceRequestMutation {
        const parsed = desktopServiceRequestMutationSchema.parse(value)
        if (parsed.serviceRequestId !== scope.serviceRequestId || !sameSource(parsed.source, scope.source)
            || new Set(parsed.choices.map(choice => choice.slug)).size !== parsed.choices.length
            || parsed.currentIndex >= parsed.choices.length) throw new Error('Saved app decisions belong to another request.')
        if (parsed.action === 'finish' && parsed.choices.some(choice => choice.choice === 'pending')) throw new Error('Choose a connection or Skip for every app before finishing.')
        return parsed
    }
    const journal = storage
        ? createServiceRequestRetryJournal(storage, `desktop-service-request-retry:v1:${JSON.stringify([scope.agentId, scope.sessionId, scope.serviceRequestId])}`, parseMutation)
        : createDurableServiceRequestRetryJournal(`${url}/retry`, scope.serviceRequestId, parseMutation, lifetime.signal, readJson)

    function current(signal: AbortSignal) {
        signal.throwIfAborted()
        if (closed) throw new Error('App request owner changed.')
    }

    async function transport(payload: DesktopServiceRequestMutation | null, signal?: AbortSignal) {
        const finish = payload?.action === 'finish' ? new AbortController() : null
        if (finish) finishControllers.add(finish)
        const timer = finish ? setTimeout(() => finish.abort(), 130_000) : null
        const combined = AbortSignal.any([finish?.signal ?? lifetime.signal, ...(!finish ? [AbortSignal.timeout(30_000)] : []), ...(signal ? [signal] : [])])
        let response: Response | undefined
        try {
            current(combined)
            response = await fetch(url, {
                method: payload ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: combined,
                headers: payload ? { 'Content-Type': 'application/json' } : {},
                ...(payload && { body: JSON.stringify(payload) }),
            })
            current(combined)
            if (!response.ok) {
                if (payload && response.status >= 400 && response.status < 500
                    && response.headers.get('x-service-request-outcome') === 'refused'
                    && response.headers.get('x-service-request-attempt-id') === payload.requestId
                    && response.headers.get('x-service-request-id') === scope.serviceRequestId) {
                    await journal.acknowledge(payload)
                    throw new DesktopServiceRequestRefused('Those choices were refused before saving. Refresh the card and choose again.')
                }
                throw new Error('App setup was refused or its acknowledgement is unknown. Refresh or retry the saved decisions.')
            }
            return { response, signal: combined, finish }
        } catch (error) {
            if (finish) { finishControllers.delete(finish); finish.abort() }
            await response?.body?.cancel().catch(() => undefined)
            throw error
        } finally {
            if (timer !== null) clearTimeout(timer)
        }
    }

    async function read(signal?: AbortSignal): Promise<DesktopServiceRequestDetail | null> {
        await journal.hydrate()
        current(signal ?? lifetime.signal)
        const result = await transport(null, signal)
        const view = desktopServiceRequestViewSchema.parse(await readJson(result.response, result.signal))
        current(result.signal)
        if (view.request) assertServiceRequestDetail(scope, view.request)
        return view.request
    }

    async function mutate(input: DesktopServiceRequestMutation, signal?: AbortSignal) {
        if (mutating) throw new Error('App decisions are already being acknowledged.')
        const payload = parseMutation(input)
        mutating = true
        try {
            current(signal ?? lifetime.signal)
            await journal.save(payload)
            const result = await transport(payload, signal)
            if (payload.action === 'progress') {
                const saved = desktopServiceProgressResultSchema.parse(await readJson(result.response, result.signal))
                current(result.signal)
                if (saved.serviceRequestId !== payload.serviceRequestId || saved.currentIndex !== payload.currentIndex
                    || JSON.stringify(saved.choices) !== JSON.stringify(payload.choices)) throw new Error('App progress acknowledgement did not match. Retry the saved decisions.')
                await journal.acknowledge(payload)
                return { action: 'progress' as const, saved }
            }
            const response = result.response
            const canonicalRunId = response.headers.get('x-run-id')
            try {
                if (response.status !== 200 || response.headers.get('x-service-request-id') !== scope.serviceRequestId
                    || response.headers.get('x-session-id') !== scope.sessionId || !canonicalRunId
                    || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(canonicalRunId)
                    || canonicalRunId !== payload.requestId && response.headers.get('x-service-request-attempt-id') !== payload.requestId
                    || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
                    throw new Error('Finish acknowledgement did not match. Retry the same Finish.')
                }
                current(result.signal)
                await journal.acknowledge(payload)
            } catch (error) {
                result.finish?.abort()
                await response.body?.cancel().catch(() => undefined)
                throw error
            } finally {
                if (result.finish) finishControllers.delete(result.finish)
            }
            // An acknowledged stream transfers to root; replacing this card must not stop its follow-up run.
            return { action: 'finish' as const, response, requestId: canonicalRunId!, signal: result.signal, cancelStream: () => result.finish?.abort() }
        } finally {
            mutating = false
        }
    }

    return {
        read,
        mutate,
        pending: () => journal.read(),
        recoverFinish(detail: DesktopServiceRequestDetail): DesktopServiceRequestMutation | null {
            assertServiceRequestDetail(scope, detail)
            if (detail.retry.phase !== 'finishing' || !detail.retry.requestId) return null
            return parseMutation({ action: 'finish', requestId: detail.retry.requestId, serviceRequestId: detail.serviceRequestId,
                source: detail.source, expectedRevision: detail.revision, currentIndex: detail.currentIndex, choices: detail.choices })
        },
        dispose() { closed = true; lifetime.abort(); for (const controller of finishControllers) controller.abort(); finishControllers.clear() },
    }
}

export type DesktopServiceRequestsClient = ReturnType<typeof createDesktopServiceRequestsClient>
