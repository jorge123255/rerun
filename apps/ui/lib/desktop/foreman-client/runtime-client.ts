'use client'

import { z } from 'zod'
import {
    foremanChatRefSchema, foremanConversationViewSchema, foremanModelRefSchema, foremanDecisionInputSchema,
    foremanDecisionSchema, foremanBuildSchema, foremanLiveEventSchema, visibleText,
    type DesktopForemanModelRef, type DesktopForemanLiveEvent,
} from '@rerun/contracts'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { fromContractBuild } from './build-progress'
import { revisionToTrustedSnapshot } from './plan-view'
import { createPlanDecisionRequestId } from './decision'
import { sameForemanChat, type DesktopForemanChatRef } from './identity'
import { flushDesktopForemanUiSaves, saveForemanUiIfMatching, type DesktopForemanActionPorts } from './actions'
import { DEFAULT_DESKTOP_FOREMAN_PLACEMENT, type DesktopForemanPersistedUi } from './persistence'

import { desktopForemanSavedUiSchema } from './ui-schema'
export { desktopForemanSavedUiSchema } from './ui-schema'
const stateSchema = z.strictObject({
    chat: foremanChatRefSchema, sessionId: z.string().min(1).max(128), model: foremanModelRefSchema.nullable(),
    view: foremanConversationViewSchema,
    messages: z.array(z.object({ id: z.string().max(256), role: z.enum(['user', 'assistant']), parts: z.array(z.unknown()).max(4096) })).max(5000),
    ui: z.strictObject({ snapshot: desktopForemanSavedUiSchema.nullable(), revision: z.number().int().nonnegative() }),
}).refine(value => sameForemanChat(value.chat, value.view.chat) && (!value.ui.snapshot || sameForemanChat(value.chat, value.ui.snapshot)), 'Foreman state belongs to another chat.')
export type DesktopForemanClientState = z.infer<typeof stateSchema>
class ForemanRequestError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message) } }
async function json(response: Response): Promise<unknown> {
    const limit = response.ok ? 4 * 1024 * 1024 : 16 * 1024
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Foreman returned an empty response.')
    let total = 0
    const chunks: Uint8Array[] = []
    try {
        for (;;) { const value = await reader.read(); if (value.done) break; total += value.value.byteLength; if (total > limit) throw new Error('Foreman response is too large.'); chunks.push(value.value) }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error }
    finally { reader.releaseLock() }
    const bytes = new Uint8Array(total); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!response.ok) {
        const error = z.object({ error: z.string().max(8192), code: z.string().max(128).optional() }).safeParse(body)
        throw new ForemanRequestError(error.success ? error.data.error : 'Foreman request failed.', response.status, error.success ? error.data.code : undefined)
    }
    return body
}
export async function readDesktopForemanState(signal?: AbortSignal): Promise<DesktopForemanClientState> {
    const response = await fetch('/api/desktop/foreman', { cache: 'no-store', signal })
    return stateSchema.parse(await json(response))
}
const post = async (input: unknown, signal?: AbortSignal) => json(await fetch('/api/desktop/foreman', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal }))
export function desktopForemanMessages(state: DesktopForemanClientState) {
    return state.messages.map(message => ({ id: message.id, role: message.role, text: visibleText(message.parts, '\n') })).filter(message => message.text.length > 0)
}
function emptyUi(chat: DesktopForemanChatRef): DesktopForemanPersistedUi {
    return { ...chat, open: true, tab: 'assistant', draft: '', pendingPlanRevisionId: null, decision: { status: 'idle' }, build: null, discoveries: null, placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT }
}
export type DesktopForemanClientOptions = {
    onState: (state: DesktopForemanClientState) => void
    onError: (message: string) => void
    onOpenCoworker: (target: { agentId: string; sessionId?: string }) => void | Promise<void>
    onOpenBox: (spaceId: string) => void | Promise<void>
    modelChoice?: () => DesktopForemanModelRef | undefined
}
/** One adapter per exact chat. Ordinary state reads never replay navigation or creation effects. */
export function createDesktopForemanClient(initial: DesktopForemanClientState, options: DesktopForemanClientOptions) {
    let state = initial, revision = initial.ui.revision
    let lastUi: DesktopForemanPersistedUi = initial.ui.snapshot ?? emptyUi(initial.chat)
    let pendingSend = initial.ui.snapshot?.pendingSend
    let sending = false
    let closed = false, refreshing: Promise<DesktopForemanClientState> | undefined
    const requests = new Set<AbortController>()
    const discoveryListeners = new Set<(event: Extract<DesktopForemanLiveEvent, { type: 'discovery' }>['event']) => void>()
    const seenNavigation = new Set<string>()
    const chat = { ...initial.chat }
    const owned = (target: DesktopForemanChatRef) => { if (closed || !sameForemanChat(chat, target)) throw new Error('This Foreman chat is no longer open.') }
    const act = async (input: unknown, signal?: AbortSignal) => {
        owned(chat)
        const controller = new AbortController(); requests.add(controller)
        try { return await post(input, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])) }
        finally { requests.delete(controller) }
    }
    const publish = (next: DesktopForemanClientState) => { owned(next.chat); state = next; options.onState(next) }
    const refresh = () => {
        if (refreshing) return refreshing
        const controller = new AbortController(); requests.add(controller)
        refreshing = readDesktopForemanState(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])).then(next => {
            publish(next)
            return next
        }).finally(() => { refreshing = undefined; requests.delete(controller) })
        return refreshing
    }
    const changed = () => { if (!closed && !isDesktopQuitting()) void refresh().catch(error => { if (!closed) options.onError(error instanceof Error ? error.message : 'Could not refresh Foreman.') }) }
    async function navigate(intent: Extract<DesktopForemanLiveEvent, { type: 'navigation' }>['intent']) {
        owned(chat)
        if (isDesktopQuitting()) return
        if (intent.kind === 'open_box') await options.onOpenBox(intent.spaceId)
        else if (intent.kind === 'open_coworker') await options.onOpenCoworker({ agentId: intent.agentId, ...(intent.sessionId ? { sessionId: intent.sessionId } : {}) })
        else {
            // Setup links always use the exact created session, never a name-based lookup.
            const setup = state.view.build?.setup
            if (setup?.state !== 'started' || setup.agentId !== intent.agentId || !setup.sessionId) throw new Error('The coworker setup chat is not available.')
            await options.onOpenCoworker({ agentId: setup.agentId, sessionId: setup.sessionId })
        }
    }
    const ports: DesktopForemanActionPorts = {
        plans: {
            readShownPlan: async target => { owned(target); const row = state.view.revisions.find(row => row.revisionId === state.view.currentRevisionId); return row ? revisionToTrustedSnapshot(row) : null },
            readConversationView: async target => { owned(target); return state.view },
        },
        persistence: {
            load: async target => { owned(target); const next = await refresh(); revision = next.ui.revision; lastUi = next.ui.snapshot ?? emptyUi(chat); pendingSend = next.ui.snapshot?.pendingSend; return next.ui.snapshot },
            save: async snapshot => {
                // A save already admitted before the panel closes must finish its durable write.
                if (!sameForemanChat(snapshot, chat)) throw new Error('Cannot save a different Foreman chat.')
                const value = desktopForemanSavedUiSchema.parse({ ...snapshot, build: null, discoveries: null, pendingSend })
                lastUi = value
                try {
                    const result = z.strictObject({ revision: z.number().int().nonnegative() }).parse(await post({ action: 'ui', chat, expectedRevision: revision, snapshot: value }, AbortSignal.timeout(15_000)))
                    revision = result.revision
                } catch (error) {
                    // A lost ACK may already have written exactly this snapshot. Recover only that
                    // fingerprint; never overwrite a newer server view or silently adopt its CAS.
                    const next = await readDesktopForemanState(AbortSignal.timeout(15_000)).catch(() => null)
                    if (next && sameForemanChat(chat, next.chat) && JSON.stringify(next.ui.snapshot) === JSON.stringify(value)) { revision = next.ui.revision; return }
                    throw error
                }
            },
        },
        conversation: {
            sendMessage: async (text, signal) => {
                owned(chat); signal?.throwIfAborted()
                if (isDesktopQuitting() || sending) return false
                sending = true
                let reserved = false, dispatched = false
                try {
                    const picked = options.modelChoice?.()
                    const choice = pendingSend && picked === undefined ? pendingSend.modelChoice : picked ?? null
                    if (pendingSend && (pendingSend.text !== text || JSON.stringify(pendingSend.modelChoice) !== JSON.stringify(choice))) throw new Error('Retry the previous message with its original model before sending a different message.')
                    if (!await flushDesktopForemanUiSaves()) throw new Error('Save this Foreman draft before sending.')
                    signal?.throwIfAborted(); owned(chat)
                    if (isDesktopQuitting()) return false
                    if (!pendingSend) { pendingSend = { requestId: createPlanDecisionRequestId(), text, modelChoice: choice }; reserved = true }
                    await saveForemanUiIfMatching(ports.persistence, lastUi)
                    signal?.throwIfAborted(); owned(chat)
                    if (isDesktopQuitting()) throw new Error('Rerun is closing.')
                    dispatched = true
                    const receipt = z.strictObject({ runId: z.string().min(1).max(128) }).parse(await act({ action: 'send', chat, requestId: pendingSend.requestId, text: pendingSend.text, ...(pendingSend.modelChoice ? { modelChoice: pendingSend.modelChoice } : {}) }, signal))
                    if (receipt.runId !== pendingSend.requestId) throw new Error('Foreman acknowledged a different message.')
                    pendingSend = undefined
                    await saveForemanUiIfMatching(ports.persistence, lastUi)
                    changed()
                    return true
                } catch (error) {
                    if (reserved && !dispatched) { pendingSend = undefined; await saveForemanUiIfMatching(ports.persistence, lastUi) }
                    throw error
                } finally { sending = false }
            },
            stop: async () => { owned(chat); z.strictObject({ ok: z.literal(true) }).parse(await act({ action: 'stop', chat })); changed() },
        },
        decisions: {
            submit: async (request, signal) => {
                owned(request.chat)
                const previous = state.view.decisions.find(decision => decision.requestId === request.requestId)
                try {
                    const decision = foremanDecisionSchema.parse(await act(previous
                        ? { action: 'recover', chat, requestId: request.requestId }
                        : { action: 'decision', input: foremanDecisionInputSchema.parse(request) }, signal))
                    if (decision.requestId !== request.requestId || decision.revisionId !== request.revisionId || decision.decision !== request.decision) throw new Error('Foreman acknowledged a different plan decision.')
                    changed()
                    return decision.state === 'acknowledged'
                        ? { ok: true, requestId: request.requestId, revisionId: request.revisionId, decisionId: decision.decisionId }
                        : { ok: false, requestId: request.requestId, revisionId: request.revisionId, error: decision.error ?? 'The decision has not been acknowledged.', uncertain: decision.state !== 'failed' }
                } catch (error) {
                    if (signal?.aborted || closed) throw error
                    return { ok: false, requestId: request.requestId, revisionId: request.revisionId, error: error instanceof Error ? error.message : 'Could not confirm this plan.', uncertain: !(error instanceof ForemanRequestError && ['stale_revision', 'digest_mismatch', 'invalid_plan', 'model_unavailable', 'not_found'].includes(error.code ?? '')) }
                }
            },
        },
        build: {
            readProgress: async target => { owned(target); return state.view.build ? fromContractBuild(state.view.build, chat) : null },
            act: async (input, signal) => {
                owned(input.chat)
                const build = foremanBuildSchema.parse(await act({ action: 'build', input }, signal))
                if (build.buildId !== input.buildId) throw new Error('Foreman returned a different build.')
                state = { ...state, view: { ...state.view, build } }; publish(state)
                return fromContractBuild(build, chat)
            },
        },
        discovery: {
            capabilities: () => ({ available: true }),
            subscribe: (target, listener, signal) => { owned(target); if (signal?.aborted) return () => undefined; discoveryListeners.add(listener); const stop = () => { discoveryListeners.delete(listener); signal?.removeEventListener('abort', stop) }; signal?.addEventListener('abort', stop, { once: true }); return stop },
        },
        navigation: { dispatch: async request => { owned(request); await navigate(request.intent) } },
        routines: { list: async () => ({ available: false, reason: 'Open a coworker’s Automations panel to manage schedules.', routines: [] }) },
    }
    const acceptEvent = (value: unknown) => {
        if (closed || isDesktopQuitting()) return
        const parsed = foremanLiveEventSchema.safeParse(value)
        if (!parsed.success) return
        const event = parsed.data
        const target = 'binding' in event ? event.binding : event.chat
        if (!sameForemanChat(chat, target)) return
        if (event.type === 'navigation') {
            const live = state.view.live
            if (!live || live.runId !== event.binding.runId || live.model.connectionId !== event.binding.model.connectionId || live.model.model !== event.binding.model.model || seenNavigation.has(event.eventId)) return
            seenNavigation.add(event.eventId)
            if (seenNavigation.size > 256) seenNavigation.delete(seenNavigation.values().next().value!)
            void navigate(event.intent).catch(error => { if (!closed) options.onError(error instanceof Error ? error.message : 'Could not open this item.') })
        } else if (event.type === 'discovery') {
            if (state.view.live?.runId !== event.runId) return
            for (const listener of discoveryListeners) listener(event.event)
            changed()
        } else changed()
    }
    return { ports, refresh, acceptEvent, close: () => { closed = true; for (const request of requests) request.abort(); requests.clear(); discoveryListeners.clear() } }
}
