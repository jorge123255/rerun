import 'server-only'
import { z } from 'zod'
import type { DelegationRuntime } from '../../../../../engine/src/desktop/delegation/runtime'

const id = z.string().min(1).max(200)
const stopSchema = z.object({ operation: z.literal('stop-task'), requestId: z.string().uuid(), delegationId: z.string().uuid(), taskId: z.string().uuid(), expectedRevision: z.string().uuid() }).strict()
const headers = { 'Cache-Control': 'no-store' }

export type DelegationSessionAuthority = (request: Request, sessionId: string, action: 'read' | 'stop') => Promise<{ parentAgentId: string; parentSessionId: string }>

function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error('Delegation request deadline exceeded'))
        signal.addEventListener('abort', onAbort, { once: true })
        work.then(value => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
        }, error => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
        })
        if (signal.aborted) onAbort()
    })
}

async function readStopBody(request: Request, signal: AbortSignal): Promise<unknown> {
    const reader = request.body?.getReader()
    if (!reader) throw new Error('Missing Stop body')
    let text = ''
    let size = 0
    const decoder = new TextDecoder()
    try {
        while (true) {
            signal.throwIfAborted()
            const part = await withDeadline(reader.read(), signal)
            if (part.done) break
            size += part.value.byteLength
            if (size > 4096) throw new Error('Stop body exceeds limit')
            text += decoder.decode(part.value, { stream: true })
        }
        text += decoder.decode()
    } finally {
        await reader.cancel().catch(() => {})
    }
    signal.throwIfAborted()
    return JSON.parse(text)
}

export function delegationApi(runtime: Pick<DelegationRuntime, 'list' | 'stop'>, authorize: DelegationSessionAuthority) {
    return async (request: Request, sessionId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
        try {
            id.parse(sessionId)
            if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'Method unavailable' }, { status: 405, headers })
            const owner = await withDeadline(authorize(request, sessionId, request.method === 'GET' ? 'read' : 'stop'), signal)
            signal.throwIfAborted()
            if (owner.parentSessionId !== sessionId) throw new Error('Session mismatch')
            if (request.method === 'GET') {
                const delegations = (await withDeadline(runtime.list(sessionId), signal)).filter(delegation => delegation.parentAgentId === owner.parentAgentId)
                signal.throwIfAborted()
                return Response.json({ delegations }, { headers })
            }
            const body = stopSchema.parse(await readStopBody(request, signal))
            const current = await withDeadline(authorize(request, sessionId, 'stop'), signal)
            signal.throwIfAborted()
            if (current.parentAgentId !== owner.parentAgentId || current.parentSessionId !== sessionId) throw new Error('Session changed')
            // Stop can wait for the exact child to drain and retire its workspace.
            const stopSignal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)])
            return Response.json({ delegation: await withDeadline(runtime.stop(current, body), stopSignal) }, { headers })
        } catch {
            return Response.json({ error: 'Delegation unavailable or changed. Refresh and retry Stop.' }, { status: 409, headers })
        }
    }
}
