import 'server-only'
import { z } from 'zod'
import type { Client } from '@libsql/client'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { findDesktopAgent } from '../store'
import { desktopTriggerEngine } from './engine'
import { projectDesktopTriggerHistory } from './history'
import { adoptDesktopTriggerSession } from './adoption'

export type TriggerAccess = (engineAgentId: string) => Promise<void>
export const TRIGGER_BODY_TIMEOUT_MS = 10000
export const TRIGGER_BODY_CLEANUP_MS = 1000
export type DesktopTriggerDurableStore = Pick<import('../../../../../engine/src/desktop/triggers/types').DesktopTriggerStore, 'getRevision' | 'bumpRevision' | 'findMutation' | 'rememberMutation' | 'listEvents'>
export async function readDesktopTriggerBody(request: Request, limit = 131072): Promise<unknown> {
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Trigger body required')
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TRIGGER_BODY_TIMEOUT_MS)])
    const chunks: Uint8Array[] = []; let bytes = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) throw new DesktopHttpError(413, 'Trigger request is too large'); chunks.push(part.value) }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
}

export function desktopTriggersApi(db: Client, authorize: TriggerAccess, _legacyDurable?: DesktopTriggerDurableStore) {
    return async (request: Request, agentId: string): Promise<Response> => {
        try {
            const runtime = await authenticateDesktopRequest(request)
            const owner = await findDesktopAgent(db, agentId)
            if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
            await authorize(owner.engineAgentId)
            const url = new URL(request.url), action = url.searchParams.get('action')
            let op: string, slug: string | undefined, input: unknown
            if (request.method === 'GET') {
                slug = url.searchParams.get('slug') ?? undefined
                op = action === 'history' ? 'history' : slug ? 'get' : 'list'
            } else {
                const body = z.record(z.string(), z.unknown()).parse(await readDesktopTriggerBody(request))
                slug = body.slug === undefined ? undefined : z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).parse(body.slug)
                if (request.method === 'PUT') { op = slug ? 'update' : 'create'; input = body.input ?? body }
                else if (request.method === 'DELETE') { op = 'delete'; const { slug: _slug, ...rest } = body; input = rest }
                else if (request.method === 'POST' && (body.action === 'rotate' || body.action === 'stop')) { op = body.action; const { slug: _slug, action: _action, ...rest } = body; input = rest }
                else throw new DesktopHttpError(400, 'Invalid trigger action')
            }
            request.signal.throwIfAborted()
            const latest = await findDesktopAgent(db, agentId)
            if (!latest || latest.engineAgentId !== owner.engineAgentId) throw new DesktopHttpError(409, 'Coworker identity changed')
            const result = await desktopTriggerEngine(runtime, { op, localAgentId: agentId, engineAgentId: owner.engineAgentId, ...(slug ? { slug } : {}), ...(input !== undefined ? { input } : {}) }, request.signal)
            return Response.json(op === 'history' ? await projectDesktopTriggerHistory(runtime, db, agentId, result, request.signal) : result, { status: op === 'create' ? 201 : 200, headers: { 'Cache-Control': 'no-store' } })
        } catch (error) {
            return Response.json({ error: error instanceof DesktopHttpError ? error.message : 'Trigger request failed' }, { status: error instanceof DesktopHttpError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } })
        }
    }
}
export async function openTriggerResultChat(db: Client, engine: Parameters<typeof adoptDesktopTriggerSession>[1], input: { agentId: string; engineAgentId: string; engineSessionId: string; runId: string | null }) { return adoptDesktopTriggerSession(db, engine, input) }
