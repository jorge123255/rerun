import 'server-only'
import { z } from 'zod'
import type { DelegationRuntime } from '../../../../../engine/src/desktop/delegation/runtime'
const id = z.string().min(1).max(200)
const stopSchema = z.object({ operation: z.literal('stop-task'), requestId: z.string().uuid(), delegationId: z.string().uuid(), taskId: z.string().uuid(), expectedRevision: z.string().uuid() }).strict()
export type DelegationSessionAuthority = (request: Request, sessionId: string, action: 'read' | 'stop') => Promise<{ parentAgentId: string; parentSessionId: string }>
export function delegationApi(runtime: DelegationRuntime, authorize: DelegationSessionAuthority) {
    return async (request: Request, sessionId: string): Promise<Response> => {
        try {
            id.parse(sessionId)
            if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'Method unavailable' }, { status: 405 })
            const owner = await authorize(request, sessionId, request.method === 'GET' ? 'read' : 'stop')
            if (owner.parentSessionId !== sessionId) throw new Error('Session mismatch')
            if (request.method === 'GET') {
                const delegations = (await runtime.list(sessionId)).filter(d => d.parentAgentId === owner.parentAgentId)
                return Response.json({ delegations }, { headers: { 'Cache-Control': 'no-store' } })
            }
            const reader = request.body?.getReader(); if (!reader) throw new Error('Missing Stop body')
            let text = '', size = 0; const decoder = new TextDecoder()
            try {
                while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) throw new Error('Stop body exceeds limit'); text += decoder.decode(part.value, { stream: true }) }
                text += decoder.decode()
            } finally { await reader.cancel().catch(() => {}) }
            const body = stopSchema.parse(JSON.parse(text))
            // Revalidate after reading the body; authorize includes same-origin/CSRF protection.
            const current = await authorize(request, sessionId, 'stop')
            if (current.parentAgentId !== owner.parentAgentId || current.parentSessionId !== sessionId) throw new Error('Session changed')
            return Response.json({ delegation: await runtime.stop(current, body) }, { headers: { 'Cache-Control': 'no-store' } })
        } catch { return Response.json({ error: 'Delegation unavailable or changed. Refresh and retry Stop.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } }) }
    }
}
