'use client'

import type { DesktopDelegationSnapshot, DesktopDelegationTask } from '@rerun/contracts'
import type { SubRunCall, SubRunStatus } from '@rerun/contracts'

export const DELEGATION_LIST_UNAVAILABLE = 'Delegated tasks could not be loaded.'
export const DELEGATION_LIST_UNREADABLE = 'Delegated tasks could not be read.'
export const DELEGATION_STOP_UNAVAILABLE = 'Delegation unavailable or changed. Refresh and retry Stop.'
export const DELEGATION_STOP_UNFINISHED = 'Stop is still unfinished. Retry Stop.'
export const DELEGATION_UNREADABLE = 'Delegation response could not be read. Refresh and retry Stop.'

export type DesktopDelegationReadKind = 'unavailable' | 'malformed' | 'unfinished'

/** Transport and shape failures stay distinct. AbortError is not one of these. */
export class DesktopDelegationReadError extends Error {
    readonly kind: DesktopDelegationReadKind
    constructor(kind: DesktopDelegationReadKind, message: string) {
        super(message)
        this.name = 'DesktopDelegationReadError'
        this.kind = kind
    }
}

const LIST_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 120_000
const ID_MAX = 200
const TITLE_MAX = 2_000
const TEXT_MAX = 8_000
const TASK_MAX = 64
const CALL_MAX = 32
const COUNT_MAX = 1_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STATUSES = new Set<SubRunStatus>(['queued', 'running', 'done', 'error', 'stopped', 'dispatched'])
const CLEANUP = new Set(['pending', 'complete', 'blocked'])

// Same page retries of one Stop share a request id. A new revision is a new attempt.
const stopRequestIds = new Map<string, string>()

export type DesktopDelegationStopInput = {
    delegationId: string
    taskId: string
    expectedRevision: string
}

export type DesktopDelegationFilter = {
    sessionId: string
    agentId?: string
    toolCallId?: string
    parentRunId?: string
}

export type DesktopDelegationClient = {
    list(sessionId: string, signal?: AbortSignal): Promise<DesktopDelegationSnapshot[]>
    stop(sessionId: string, input: DesktopDelegationStopInput, signal?: AbortSignal): Promise<DesktopDelegationSnapshot>
    dispose(): void
}

export function delegationUrl(sessionId: string): string {
    return `/api/desktop/sessions/${encodeURIComponent(sessionId)}/delegation`
}

export function visibleDelegations(delegations: readonly DesktopDelegationSnapshot[], filter: DesktopDelegationFilter): DesktopDelegationSnapshot[] {
    return delegations.filter(item => {
        if (item.parentSessionId !== filter.sessionId) return false
        if (filter.agentId !== undefined && item.parentAgentId !== filter.agentId) return false
        if (filter.toolCallId !== undefined && item.toolCallId !== filter.toolCallId) return false
        if (filter.parentRunId !== undefined && item.parentRunId !== filter.parentRunId) return false
        return true
    })
}

function fail(message: string): never {
    throw new Error(message)
}

function record(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message)
    return value as Record<string, unknown>
}

function text(value: unknown, max: number, message: string): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) fail(message)
    return value
}

function optionalText(source: Record<string, unknown>, key: string, max: number, message: string): string | undefined {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) return undefined
    if (typeof source[key] !== 'string' || (source[key] as string).length > max) fail(message)
    return source[key] as string
}

function count(value: unknown, message: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > COUNT_MAX) fail(message)
    return value
}

function optionalNumber(source: Record<string, unknown>, key: string, message: string): number | undefined {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) return undefined
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key] as number)) fail(message)
    return source[key] as number
}

function readCall(value: unknown, message: string): SubRunCall {
    const call = record(value, message)
    if (typeof call.summary !== 'string' || call.summary.length > TEXT_MAX) fail(message)
    const view: SubRunCall = { tool: text(call.tool, ID_MAX, message), summary: call.summary }
    if (Object.prototype.hasOwnProperty.call(call, 'failed') && call.failed !== undefined) {
        if (typeof call.failed !== 'boolean') fail(message)
        view.failed = call.failed
    }
    const durationMs = optionalNumber(call, 'durationMs', message)
    const elapsedMs = optionalNumber(call, 'elapsedMs', message)
    if (durationMs !== undefined) view.durationMs = durationMs
    if (elapsedMs !== undefined) view.elapsedMs = elapsedMs
    return view
}

export function readDelegationSnapshot(value: unknown, message = DELEGATION_UNREADABLE): DesktopDelegationSnapshot {
    const source = record(value, message)
    if (!Array.isArray(source.tasks) || source.tasks.length > TASK_MAX) fail(message)
    const tasks = source.tasks.map(item => {
        const task = record(item, message)
        if (!STATUSES.has(task.status as SubRunStatus) || !CLEANUP.has(task.cleanup as string)) fail(message)
        if (!Array.isArray(task.calls) || task.calls.length > CALL_MAX) fail(message)
        if (typeof task.preview !== 'string' || task.preview.length > TEXT_MAX) fail(message)
        const view: DesktopDelegationTask = {
            taskId: text(task.taskId, ID_MAX, message),
            title: typeof task.title === 'string' && task.title.length <= TITLE_MAX ? task.title : fail(message),
            status: task.status as SubRunStatus,
            steps: count(task.steps, message),
            toolCalls: count(task.toolCalls, message),
            failures: count(task.failures, message),
            preview: task.preview,
            calls: task.calls.map(call => readCall(call, message)),
            cleanup: task.cleanup as DesktopDelegationTask['cleanup'],
        }
        if (!UUID.test(view.taskId)) fail(message)
        const activity = optionalText(task, 'activity', ID_MAX, message)
        const error = optionalText(task, 'error', TEXT_MAX, message)
        const result = optionalText(task, 'result', TEXT_MAX, message)
        const idleMs = optionalNumber(task, 'idleMs', message)
        const startedAt = optionalNumber(task, 'startedAt', message)
        const finishedAt = optionalNumber(task, 'finishedAt', message)
        if (activity !== undefined) view.activity = activity
        if (error !== undefined) view.error = error
        if (result !== undefined) view.result = result
        if (idleMs !== undefined) view.idleMs = idleMs
        if (startedAt !== undefined) view.startedAt = startedAt
        if (finishedAt !== undefined) view.finishedAt = finishedAt
        return view
    })
    const snapshot: DesktopDelegationSnapshot = {
        delegationId: text(source.delegationId, ID_MAX, message),
        revision: text(source.revision, ID_MAX, message),
        parentAgentId: text(source.parentAgentId, ID_MAX, message),
        parentSessionId: text(source.parentSessionId, ID_MAX, message),
        parentRunId: text(source.parentRunId, ID_MAX, message),
        toolCallId: text(source.toolCallId, ID_MAX, message),
        tasks,
    }
    if (!UUID.test(snapshot.delegationId) || !UUID.test(snapshot.revision)) fail(message)
    return snapshot
}

export function readDelegationList(value: unknown, message = DELEGATION_LIST_UNREADABLE): DesktopDelegationSnapshot[] {
    const body = record(value, message)
    if (!Array.isArray(body.delegations)) fail(message)
    return body.delegations.map(item => readDelegationSnapshot(item, message))
}

/** Transcript or parent payload in the GET shape. Order is preserved. A shape failure throws. */
export function projectDelegations(value: unknown, filter: DesktopDelegationFilter): DesktopDelegationSnapshot[] {
    return visibleDelegations(readDelegationList(value, DELEGATION_LIST_UNREADABLE), filter)
}

function sessionIdOf(sessionId: string, message: string): string {
    return text(sessionId, ID_MAX, message)
}

async function readBody(response: Response): Promise<unknown> {
    const body = await response.text()
    if (!body) return null
    try {
        return JSON.parse(body) as unknown
    } catch {
        return null
    }
}

function errorText(body: unknown, fallback: string): string {
    if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
        const message = (body as { error: string }).error.trim()
        if (message) return message.slice(0, TEXT_MAX)
    }
    return fallback
}

function abortError(): Error {
    const error = new Error('aborted')
    error.name = 'AbortError'
    return error
}

function isAbort(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'name' in error && (error as { name: string }).name === 'AbortError'
}

function wrapRead(error: unknown, kind: DesktopDelegationReadKind, fallback: string): DesktopDelegationReadError {
    if (error instanceof DesktopDelegationReadError) return error
    const message = error instanceof Error && error.message ? error.message : fallback
    return new DesktopDelegationReadError(kind, message)
}

export function createDesktopDelegationClient(requestIds = stopRequestIds): DesktopDelegationClient {
    const controllers = new Set<AbortController>()
    let closed = false

    function link(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; release: () => void } {
        const controller = new AbortController()
        controllers.add(controller)
        const signals = [controller.signal, AbortSignal.timeout(timeoutMs)]
        if (signal) signals.push(signal)
        return {
            signal: AbortSignal.any(signals),
            release: () => { controllers.delete(controller) },
        }
    }

    async function request(sessionId: string, timeoutMs: number, unavailable: string, timeoutMessage: string, signal: AbortSignal | undefined, init: RequestInit): Promise<unknown> {
        if (closed) throw abortError()
        const linked = link(timeoutMs, signal)
        try {
            const response = await fetch(delegationUrl(sessionIdOf(sessionId, unavailable)), {
                ...init,
                cache: 'no-store',
                credentials: 'same-origin',
                redirect: 'error',
                signal: linked.signal,
            })
            if (signal?.aborted || closed) throw abortError()
            const body = await readBody(response)
            if (signal?.aborted || closed) throw abortError()
            if (!response.ok) throw new Error(errorText(body, unavailable))
            return body
        } catch (error) {
            if (signal?.aborted || closed) throw abortError()
            if (isAbort(error)) throw new Error(timeoutMessage)
            if (error instanceof Error && error.message && !(error instanceof TypeError)) throw error
            throw new Error(unavailable)
        } finally {
            linked.release()
        }
    }

    return {
        async list(sessionId, signal) {
            let body: unknown
            try {
                body = await request(sessionId, LIST_TIMEOUT_MS, DELEGATION_LIST_UNAVAILABLE, DELEGATION_LIST_UNAVAILABLE, signal, { method: 'GET' })
            } catch (error) {
                if (isAbort(error)) throw error
                throw wrapRead(error, 'unavailable', DELEGATION_LIST_UNAVAILABLE)
            }
            try {
                return readDelegationList(body, DELEGATION_LIST_UNREADABLE)
            } catch (error) {
                throw wrapRead(error, 'malformed', DELEGATION_LIST_UNREADABLE)
            }
        },
        async stop(sessionId, input, signal) {
            let session = ''
            let delegationId = ''
            let taskId = ''
            let expectedRevision = ''
            let requestId = ''
            try {
                session = sessionIdOf(sessionId, DELEGATION_STOP_UNAVAILABLE)
                delegationId = text(input.delegationId, ID_MAX, DELEGATION_STOP_UNAVAILABLE)
                taskId = text(input.taskId, ID_MAX, DELEGATION_STOP_UNAVAILABLE)
                expectedRevision = text(input.expectedRevision, ID_MAX, DELEGATION_STOP_UNAVAILABLE)
                if (!UUID.test(delegationId) || !UUID.test(taskId) || !UUID.test(expectedRevision)) fail(DELEGATION_STOP_UNAVAILABLE)
                const key = JSON.stringify([delegationId, taskId, expectedRevision])
                requestId = requestIds.get(key) ?? ''
                if (!requestId) {
                    requestId = crypto.randomUUID()
                    requestIds.set(key, requestId)
                }
            } catch (error) {
                throw wrapRead(error, 'unavailable', DELEGATION_STOP_UNAVAILABLE)
            }
            let body: unknown
            try {
                body = await request(session, STOP_TIMEOUT_MS, DELEGATION_STOP_UNAVAILABLE, DELEGATION_STOP_UNFINISHED, signal, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ operation: 'stop-task', requestId, delegationId, taskId, expectedRevision }),
                })
            } catch (error) {
                if (isAbort(error)) throw error
                const message = error instanceof Error ? error.message : ''
                throw wrapRead(error, message === DELEGATION_STOP_UNFINISHED ? 'unfinished' : 'unavailable', DELEGATION_STOP_UNAVAILABLE)
            }
            try {
                const payload = record(body, DELEGATION_STOP_UNAVAILABLE)
                const snapshot = readDelegationSnapshot(payload.delegation, DELEGATION_STOP_UNAVAILABLE)
                if (snapshot.parentSessionId !== session || snapshot.delegationId !== delegationId || !snapshot.tasks.some(task => task.taskId === taskId)) fail(DELEGATION_STOP_UNAVAILABLE)
                return snapshot
            } catch (error) {
                throw wrapRead(error, 'malformed', DELEGATION_STOP_UNAVAILABLE)
            }
        },
        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
        },
    }
}
