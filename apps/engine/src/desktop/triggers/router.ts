import { HttpError } from '../../lib/errors.js'
import { readTriggerEventForSession, triggerHumanSourceSchema, assertTriggerHumanPermission, stopTriggerHumanRequest } from './human.js'
import { Hono } from 'hono'
import { desktopTriggerHistory } from './history.js'
import { z } from 'zod'
import { desktopApp } from '../policy.js'
import { DesktopTriggerLifecycleError } from './lifecycle.js'
import { DesktopTriggerStopError } from './stop.js'
import { dispatchDesktopTriggerFire } from './dispatch.js'
import { desktopTriggerFireInputSchema } from '@rerun/contracts'
import type { DesktopTriggerEngineBinding } from './binding.js'

const requestSchema = z.strictObject({ launchNonce: z.string().min(1), op: z.enum(['list', 'get', 'create', 'update', 'rotate', 'delete', 'history', 'stop', 'fire', 'event', 'session', 'human-authorize', 'human-stop', 'human-stop-receipt', 'continuations']), localAgentId: z.string().min(1).max(200), engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(), input: z.unknown().optional() })
export function createDesktopTriggerRoutes(source: DesktopTriggerEngineBinding | (() => DesktopTriggerEngineBinding | null), launchNonce: string) {
    const router = new Hono()
    router.post('/manage', async c => {
        try {
            if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
            const binding = typeof source === 'function' ? source() : source
            if (!binding) return c.json({ error: 'Triggers are starting' }, 503)
            const reader = c.req.raw.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0
            if (!reader) return c.json({ error: 'Body required' }, 400)
            const stop = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)])
            const cancel = () => { void reader.cancel().catch(() => {}) }
            stop.addEventListener('abort', cancel, { once: true })
            try { while (true) { stop.throwIfAborted(); const part = await reader.read(); stop.throwIfAborted(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1200000) return c.json({ error: 'Body too large' }, 413); chunks.push(part.value) } }
            finally { stop.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
            const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            if (input.launchNonce !== launchNonce) return c.json({ error: 'Trigger launch changed' }, 409)
            binding.authority.assertActive()
            const owner = await binding.authority.resolveOwnerByEngineId(input.engineAgentId)
            if (owner.localAgentId !== input.localAgentId || owner.engineAgentId !== input.engineAgentId || owner.deleting) return c.json({ error: 'Coworker identity changed' }, 409)
            const life = binding.lifecycle, id = input.engineAgentId
            let result: unknown
            if (input.op === 'session') {
                const query = z.strictObject({ sessionId: z.string().min(1) }).parse(input.input)
                const event = await readTriggerEventForSession(id, query.sessionId)
                if (event && event.localAgentId !== owner.localAgentId) throw new HttpError(409, 'Webhook owner changed')
                if (event) { const { payloadPreview: _payload, ...safe } = event; result = { event: safe } } else result = { event: null }
            } else if (input.op === 'event') {
                const query = z.strictObject({ eventId: z.string().min(1) }).parse(input.input)
                const event = await binding.store.getEvent(id, query.eventId)
                if (event && event.localAgentId !== owner.localAgentId) throw new HttpError(409, 'Webhook owner changed')
                if (event) { const { payloadPreview: _payload, ...safe } = event; result = { event: safe } } else result = { event: null }
            } else if (input.op === 'human-authorize') { await assertTriggerHumanPermission(id, triggerHumanSourceSchema.parse(input.input)); result = { authorized: true } }
            else if (input.op === 'human-stop' || input.op === 'human-stop-receipt') result = await stopTriggerHumanRequest(id, input.input, input.op === 'human-stop-receipt')
            else if (input.op === 'continuations') {
                const query = z.strictObject({ eventId: z.string().min(1), sessionId: z.string().min(1) }).parse(input.input)
                const event = await readTriggerEventForSession(id, query.sessionId)
                if (!event || event.eventId !== query.eventId || event.localAgentId !== owner.localAgentId) throw new HttpError(409, 'Webhook conversation changed')
                result = { runs: (await binding.store.listHumanAdmissions?.(id,event.eventId,query.sessionId) ?? []).map(row=>row.runId) }
            }
            else if (input.op === 'list') result = { triggers: await life.list(id) }
            else if (input.op === 'history') result = await desktopTriggerHistory(binding, id, input.slug)
            else if (input.op === 'create') result = await life.create(id, input.input as never)
            else if (input.op === 'stop') result = await binding.stopRun(owner.localAgentId, id, input.input)
            else {
                if (!input.slug) return c.json({ error: 'Trigger required' }, 400)
                if (input.op === 'get') result = await life.get(id, input.slug, { includeToken: true })
                else if (input.op === 'update') result = await life.update(id, input.slug, input.input as never)
                else if (input.op === 'rotate') result = await life.rotate(id, input.slug, input.input)
                else if (input.op === 'delete') result = await life.remove(id, input.slug, input.input)
                else {
                    if (!binding.networking.origin().enabled) return c.json({ error: 'Local webhook delivery is unavailable' }, 404)
                    result = await dispatchDesktopTriggerFire({ authority: binding.authority, store: binding.store, engineAgentId: id, slug: input.slug, fire: desktopTriggerFireInputSchema.parse(input.input) })
                }
            }
            return c.json({ result })
        } catch (error) {
            const status = error instanceof HttpError || error instanceof DesktopTriggerLifecycleError || error instanceof DesktopTriggerStopError ? error.status : 400
            return c.json({ error: error instanceof HttpError || error instanceof DesktopTriggerLifecycleError || error instanceof DesktopTriggerStopError ? error.message : 'Trigger request failed' }, status as 400)
        }
    })
    return router
}
