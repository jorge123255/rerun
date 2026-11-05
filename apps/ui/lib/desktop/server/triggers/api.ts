import 'server-only'
import { z } from 'zod'
import type { Client } from '@libsql/client'
import {
    desktopTriggerCreateSchema,
    desktopTriggerMutateSchema,
    desktopTriggerStopSchema,
    desktopTriggerUpdateSchema,
} from '@rerun/contracts'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { engineOf } from '../settings'
import { findDesktopAgent } from '../store'
import {
    createTrigger,
    deleteTrigger,
    getTrigger,
    listTriggers,
    rotateTriggerToken,
    updateTrigger,
    getAgent,
    cancelRun,
} from '@/lib/engine/client'
import { adoptDesktopTriggerSession, recoverDesktopTriggerChats } from './adoption'

export type TriggerAccess = (engineAgentId: string) => Promise<void>
export const TRIGGER_BODY_TIMEOUT_MS = 10_000
export const TRIGGER_BODY_CLEANUP_MS = 1_000

function abortableRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason ?? new Error('Trigger request cancelled')) }
        signal.addEventListener('abort', cancel, { once: true })
        work.then(value => { signal.removeEventListener('abort', cancel); if (signal.aborted) cancel(); else resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
        if (signal.aborted) cancel()
    })
}

async function readTriggerBody(request: Request): Promise<unknown> {
    request.signal.throwIfAborted()
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Trigger body required')
    const deadline = new AbortController()
    const signal = AbortSignal.any([request.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(new DesktopHttpError(408, 'Trigger request timed out')), TRIGGER_BODY_TIMEOUT_MS)
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const value = await abortableRead(reader.read(), signal)
            signal.throwIfAborted()
            if (value.done) break
            size += value.value.byteLength
            if (size > 70_000) throw new DesktopHttpError(413, 'Trigger request is too large')
            chunks.push(value.value)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        await new Promise<void>(resolve => {
            const cleanup = setTimeout(resolve, TRIGGER_BODY_CLEANUP_MS)
            const done = () => { clearTimeout(cleanup); resolve() }
            reader.cancel().then(done, done)
        })
    }
}

/** REQUIRED durable revision/mutation/event authority. Never optional; never in-memory. */
export type DesktopTriggerDurableStore = {
    getRevision(engineAgentId: string, slug: string): Promise<string>
    bumpRevision(engineAgentId: string, slug: string): Promise<string>
    findMutation(engineAgentId: string, requestId: string): Promise<{ kind: string; resultJson: string } | null>
    rememberMutation(input: { engineAgentId: string; requestId: string; kind: string; slug: string; resultJson: string }): Promise<void>
    listEvents(engineAgentId: string, slug?: string): Promise<unknown[]>
}

function assertDurable(durable: DesktopTriggerDurableStore | null | undefined): DesktopTriggerDurableStore {
    if (!durable || typeof durable.getRevision !== 'function' || typeof durable.bumpRevision !== 'function'
        || typeof durable.findMutation !== 'function' || typeof durable.rememberMutation !== 'function'
        || typeof durable.listEvents !== 'function') {
        throw new DesktopHttpError(503, 'Trigger durable store is not configured. Root must inject bindDesktopTriggers persistence before management admits work.')
    }
    return durable
}

/**
 * Authenticated management API. `durable` is REQUIRED — process-local revision maps are forbidden.
 * Root wires the engine-side store from bindDesktopTriggers (or an equivalent durable adapter).
 */
export function desktopTriggersApi(db: Client, authorize: TriggerAccess, durable: DesktopTriggerDurableStore) {
    const revisions = assertDurable(durable)
    return async (request: Request, agentId: string): Promise<Response> => {
        try {
            const runtime = await authenticateDesktopRequest(request)
            const engine = engineOf(runtime)
            const owner = await findDesktopAgent(db, agentId)
            if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
            await authorize(owner.engineAgentId)
            const detail = await getAgent(engine, owner.engineAgentId)
            if (detail.id !== owner.engineAgentId) throw new DesktopHttpError(409, 'Coworker identity mismatch')

            const url = new URL(request.url)
            const action = url.searchParams.get('action')

            if (request.method === 'GET' && action === 'history') {
                await recoverDesktopTriggerChats(db, engine, agentId, { signal: request.signal, engineAgentId: owner.engineAgentId }).catch(() => [])
                const slug = url.searchParams.get('slug') ?? undefined
                // Durable event ledger only — never invent captured payloads from a bare run list.
                return Response.json(await revisions.listEvents(owner.engineAgentId, slug), { headers: { 'Cache-Control': 'no-store' } })
            }

            if (request.method === 'GET') {
                const slug = url.searchParams.get('slug')
                if (slug) {
                    const trigger = await getTrigger(engine, owner.engineAgentId, slug)
                    const revision = await revisions.getRevision(owner.engineAgentId, slug)
                    return Response.json({ ...trigger, revision, url: null }, { headers: { 'Cache-Control': 'no-store' } })
                }
                const triggers = await listTriggers(engine, owner.engineAgentId)
                const result = []
                for (const trigger of triggers) {
                    const revision = await revisions.getRevision(owner.engineAgentId, trigger.slug)
                    const { token: _token, ...rest } = trigger as typeof trigger & { token?: string }
                    result.push({ ...rest, revision, url: null })
                }
                return Response.json({ triggers: result }, { headers: { 'Cache-Control': 'no-store' } })
            }

            const body = await readTriggerBody(request) as Record<string, unknown>
            request.signal.throwIfAborted()
            await authorize(owner.engineAgentId)
            request.signal.throwIfAborted()

            if (request.method === 'POST' && body.action === 'stop') {
                const stop = desktopTriggerStopSchema.parse(body)
                // Exact run cancel through engine; siblings untouched.
                try {
                    await cancelRun(engine, owner.engineAgentId, stop.runId)
                } catch {
                    throw new DesktopHttpError(502, 'Could not stop this trigger run')
                }
                return Response.json({ canceled: true }, { headers: { 'Cache-Control': 'no-store' } })
            }

            if (request.method === 'POST' && body.action === 'rotate') {
                const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).parse(body.slug)
                const mutate = desktopTriggerMutateSchema.parse(body)
                const prior = await revisions.findMutation(owner.engineAgentId, mutate.requestId)
                if (prior) return Response.json(JSON.parse(prior.resultJson), { headers: { 'Cache-Control': 'no-store' } })
                const expected = await revisions.getRevision(owner.engineAgentId, slug)
                if (expected !== mutate.expectedRevision) throw new DesktopHttpError(409, 'Trigger changed since you opened it')
                const trigger = await rotateTriggerToken(engine, owner.engineAgentId, slug)
                const revision = await revisions.bumpRevision(owner.engineAgentId, slug)
                const result = { ...trigger, revision, url: null }
                await revisions.rememberMutation({ engineAgentId: owner.engineAgentId, requestId: mutate.requestId, kind: 'rotate', slug, resultJson: JSON.stringify(result) })
                return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
            }

            if (request.method === 'PUT') {
                if (body.slug) {
                    const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).parse(body.slug)
                    const input = desktopTriggerUpdateSchema.parse(body.input ?? body)
                    const prior = await revisions.findMutation(owner.engineAgentId, input.requestId)
                    if (prior) return Response.json(JSON.parse(prior.resultJson), { headers: { 'Cache-Control': 'no-store' } })
                    const expected = await revisions.getRevision(owner.engineAgentId, slug)
                    if (expected !== input.expectedRevision) throw new DesktopHttpError(409, 'Trigger changed since you opened it')
                    const trigger = await updateTrigger(engine, owner.engineAgentId, slug, {
                        description: input.description,
                        body: input.body,
                        methods: input.methods,
                        enabled: input.enabled,
                        connectionId: input.connectionId,
                        provider: input.provider,
                        model: input.model,
                    })
                    const revision = await revisions.bumpRevision(owner.engineAgentId, slug)
                    const result = { ...trigger, revision, url: null }
                    await revisions.rememberMutation({ engineAgentId: owner.engineAgentId, requestId: input.requestId, kind: 'update', slug, resultJson: JSON.stringify(result) })
                    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
                }
                const input = desktopTriggerCreateSchema.parse(body.input ?? body)
                const prior = await revisions.findMutation(owner.engineAgentId, input.requestId)
                if (prior) return Response.json(JSON.parse(prior.resultJson), { status: 201, headers: { 'Cache-Control': 'no-store' } })
                const trigger = await createTrigger(engine, owner.engineAgentId, {
                    name: input.name,
                    description: input.description,
                    body: input.body,
                    methods: input.methods,
                    enabled: input.enabled,
                    connectionId: input.connectionId,
                    provider: input.provider,
                    model: input.model,
                })
                const revision = await revisions.bumpRevision(owner.engineAgentId, trigger.slug)
                const result = { ...trigger, revision, url: null }
                await revisions.rememberMutation({ engineAgentId: owner.engineAgentId, requestId: input.requestId, kind: 'create', slug: trigger.slug, resultJson: JSON.stringify(result) })
                return Response.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } })
            }

            if (request.method === 'DELETE') {
                const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).parse(body.slug)
                const mutate = desktopTriggerMutateSchema.parse(body)
                const prior = await revisions.findMutation(owner.engineAgentId, mutate.requestId)
                if (prior) return Response.json(JSON.parse(prior.resultJson), { headers: { 'Cache-Control': 'no-store' } })
                const expected = await revisions.getRevision(owner.engineAgentId, slug)
                if (expected !== mutate.expectedRevision) throw new DesktopHttpError(409, 'Trigger changed since you opened it — not deleting a replacement')
                await deleteTrigger(engine, owner.engineAgentId, slug)
                const revision = await revisions.bumpRevision(owner.engineAgentId, slug)
                const result = { deleted: slug, revision }
                await revisions.rememberMutation({ engineAgentId: owner.engineAgentId, requestId: mutate.requestId, kind: 'delete', slug, resultJson: JSON.stringify(result) })
                return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
            }

            throw new DesktopHttpError(400, 'Invalid trigger action')
        } catch (error) {
            return Response.json(
                { error: error instanceof DesktopHttpError ? error.message : 'Trigger request failed' },
                { status: error instanceof DesktopHttpError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } },
            )
        }
    }
}

export async function openTriggerResultChat(db: Client, engine: Parameters<typeof adoptDesktopTriggerSession>[1], input: {
    agentId: string
    engineAgentId: string
    engineSessionId: string
    runId: string | null
}) {
    return adoptDesktopTriggerSession(db, engine, input)
}
