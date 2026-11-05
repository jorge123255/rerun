import { z } from 'zod'
import type { JobReader } from '@rerun/ui/new-agent'
import { fallbackAgentName } from '@rerun/ui/new-agent/fallback-agent-name'
import { AGENT_NAME_MAX, EMPTY_READING, MAX_READABLE_LENGTH, MIN_READABLE_LENGTH, parseJobReading, type JobReading } from '@rerun/ui/new-agent/reading'
import { buildKickoff, DESCRIBED, type ScheduleChoice } from '@rerun/ui/new-agent/schedule'

/**
 * What this Mac build can offer a new coworker, next to what the hosted surfaces offer.
 *
 * The Apps picker installs connectors, Templates import another agent's setup and the planner
 * writes an automatic schedule. Those setup actions are not wired to description-based creation,
 * so the description dialog hides them. Existing coworkers have a separate Routines panel.
 */
export type DesktopNewAgentCapabilities = { apps: boolean; templates: boolean; schedule: boolean }
export const DESKTOP_NEW_AGENT_CAPABILITIES: DesktopNewAgentCapabilities = { apps: false, templates: false, schedule: false }

/** The name the server accepts, and the coworker's first message: the description, trimmed. */
export const DESKTOP_DESCRIPTION_MAX = 2000
/** The route root mounts to read a description with the connected local provider. */
export const DESKTOP_JOB_READ_ENDPOINT = '/api/desktop/new-agent/read'
export const DESKTOP_JOB_READ_TIMEOUT_MS = 6000
/** Includes the JSON envelope and escaping of the bounded model reply. */
export const DESKTOP_JOB_READ_BYTES = 64 * 1024

/**
 * Everything creating a coworker needs, and nothing that creates it. The dialog returns this to
 * root, which owns the board placement, POST /agents and the first chat message.
 *
 * `requestId` is stable across every retry of one creation. Root stores it with its receipt so a
 * resumed or repeated submission resolves to the coworker it already made instead of a second one,
 * and the same first message is never sent twice.
 */
export type DesktopCreationIntent = {
    requestId: string
    name: string
    /** The opening chat message, exactly as the user wrote it. Never rewritten, never summarised. */
    kickoff: string
    suggestionId: string | null
    /** A timing the description states, when this host can act on one. Always false here for now. */
    scheduled: boolean
}

export type DesktopCreationInput = {
    text: string
    /** The name the user typed in the pill, which wins over the one read in the description. */
    pinnedName?: string | null
    reading?: JobReading
    schedule?: ScheduleChoice
    capabilities?: DesktopNewAgentCapabilities
}

export type DesktopCreationRefusal = 'empty' | 'too-long' | 'in-flight' | 'no-name'

export function desktopCreationIntent(input: DesktopCreationInput, id: string): { intent: DesktopCreationIntent } | { refusal: DesktopCreationRefusal } {
    const text = input.text.trim()
    if (!text) return { refusal: 'empty' }
    if (text.length > DESKTOP_DESCRIPTION_MAX) return { refusal: 'too-long' }
    const capabilities = input.capabilities ?? DESKTOP_NEW_AGENT_CAPABILITIES
    const reading = input.reading ?? EMPTY_READING
    // A timing is only ever mentioned when this host can set one up: the description stays the
    // opening message either way. Description-based creation does not set up routines.
    const choice = capabilities.schedule ? input.schedule ?? DESCRIBED : DESCRIBED
    const name = (input.pinnedName?.trim() || reading.name?.trim() || fallbackAgentName(text)).slice(0, AGENT_NAME_MAX).trimEnd()
    if (!name) return { refusal: 'no-name' }
    return {
        intent: {
            requestId: id,
            name,
            kickoff: buildKickoff(text, choice, null),
            suggestionId: null,
            scheduled: capabilities.schedule ? (choice.kind === 'described' ? reading.schedule !== null : choice.kind !== 'on-demand') : false,
        },
    }
}

/** A read of the description, never a write: it creates no coworker, chat, message or grant. */
export type DesktopJobReader = { read: JobReader; cancel: () => void }

const readReply = z.object({ reply: z.string().max(8_000) }).strict()

async function boundedReply(response: Response, signal: AbortSignal): Promise<unknown> {
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > DESKTOP_JOB_READ_BYTES)) {
        void response.body?.cancel().catch(() => {})
        return null
    }
    if (!response.body || signal.aborted) {
        void response.body?.cancel().catch(() => {})
        return null
    }
    const reader = response.body.getReader()
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0
        let body = ''
        while (!signal.aborted) {
            const chunk = await reader.read()
            if (signal.aborted) return null
            if (chunk.done) return JSON.parse(body + decoder.decode())
            bytes += chunk.value.byteLength
            if (bytes > DESKTOP_JOB_READ_BYTES) {
                cancel()
                return null
            }
            body += decoder.decode(chunk.value, { stream: true })
        }
        return null
    } catch {
        cancel()
        return null
    } finally {
        signal.removeEventListener('abort', cancel)
        reader.releaseLock()
    }
}

/**
 * The bounded adapter over this Mac's connected provider. Root mounts one route that asks the
 * user's own default model and answers `{ reply }`; this side only sends the description, caps it,
 * aborts the previous read the moment a new one starts, and gives up after 6 s.
 *
 * Every failure is the honest fallback: an unavailable model, a refused request, a slow answer or
 * a reply that is not readable all resolve as an empty reading, and the dialog still names and
 * creates the coworker. No hosted key is involved, and none is assumed.
 */
export function createDesktopJobReader({ endpoint = DESKTOP_JOB_READ_ENDPOINT, timeoutMs = DESKTOP_JOB_READ_TIMEOUT_MS, fetchImpl, catalogSlugs = [], minLength = MIN_READABLE_LENGTH }: {
    endpoint?: string
    timeoutMs?: number
    fetchImpl?: typeof fetch
    /** Slugs the reply may name. A Mac dialog offers no connector, so this is empty by default. */
    catalogSlugs?: string[]
    minLength?: number
} = {}): DesktopJobReader {
    let current: AbortController | null = null
    const read: JobReader = async description => {
        current?.abort()
        current = null
        const text = description.trim().slice(0, MAX_READABLE_LENGTH)
        if (text.length < minLength) return EMPTY_READING
        const controller = new AbortController()
        current = controller
        let abort!: () => void
        const cancelled = new Promise<JobReading>(resolve => { abort = () => resolve(EMPTY_READING) })
        controller.signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const work = (async (): Promise<JobReading> => {
                const response = await (fetchImpl ?? fetch)(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ text }),
                    cache: 'no-store',
                    signal: controller.signal,
                })
                if (controller.signal.aborted || !response.ok) {
                    void response.body?.cancel().catch(() => {})
                    return EMPTY_READING
                }
                const body = readReply.safeParse(await boundedReply(response, controller.signal))
                return !controller.signal.aborted && current === controller && body.success
                    ? parseJobReading(body.data.reply, text, catalogSlugs) : EMPTY_READING
            })().catch(() => EMPTY_READING)
            // A fetch implementation or response body need not cooperate with AbortSignal.
            // Racing it makes the deadline real; the observed work still discards any late reply.
            return await Promise.race([work, cancelled])
        } catch {
            return EMPTY_READING
        } finally {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', abort)
            if (current === controller) current = null
        }
    }
    return { read, cancel: () => { current?.abort(); current = null } }
}

export type DesktopCreateOutcome = { kind: 'created' } | { kind: 'refused'; error: string } | { kind: 'uncertain'; error: string }

export type DesktopCreateState =
    | { status: 'idle' }
    /** One creation is on its way. A second press must not start another. */
    | { status: 'pending'; intent: DesktopCreationIntent }
    /** The server may or may not have made the coworker. A retry resumes this same intent. */
    | { status: 'uncertain'; intent: DesktopCreationIntent; error: string }

export const IDLE_CREATION: DesktopCreateState = { status: 'idle' }

export function requestId(): string {
    // The receipt key behind exactly-once creation: `randomUUID` exists in every secure context
    // this app is served from, and the fallback keeps one creation apart even if it ever is not.
    return globalThis.crypto?.randomUUID?.() ?? `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export type DesktopCreateRequest = { state: DesktopCreateState; intent: DesktopCreationIntent | null; refusal?: DesktopCreationRefusal }

/**
 * The one place a creation starts. A pending creation swallows the press, and an uncertain one
 * hands back the very same intent so root can look up its receipt instead of creating again.
 */
export function requestDesktopCreation(state: DesktopCreateState, input: DesktopCreationInput, makeRequestId: () => string = requestId): DesktopCreateRequest {
    if (state.status === 'pending') return { state, intent: null, refusal: 'in-flight' }
    if (state.status === 'uncertain') return { state: { status: 'pending', intent: state.intent }, intent: state.intent }
    const built = desktopCreationIntent(input, makeRequestId())
    if ('refusal' in built) return { state, intent: null, refusal: built.refusal }
    return { state: { status: 'pending', intent: built.intent }, intent: built.intent }
}

/** A definite refusal is safe to retry with a fresh receipt; an uncertain one is not. */
export function settleDesktopCreation(state: DesktopCreateState, outcome: DesktopCreateOutcome): DesktopCreateState {
    if (outcome.kind !== 'uncertain') return IDLE_CREATION
    return state.status === 'pending' ? { status: 'uncertain', intent: state.intent, error: outcome.error } : state
}
