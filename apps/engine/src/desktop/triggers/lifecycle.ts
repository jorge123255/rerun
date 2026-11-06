import { createHash } from 'node:crypto'
import { DESKTOP_TRIGGER_SLUG_RE, desktopTriggerCreateSchema, desktopTriggerMutateSchema, desktopTriggerUpdateSchema, type DesktopTrigger, type DesktopTriggerCreate, type DesktopTriggerPublic, type DesktopTriggerUpdate } from '@rerun/contracts'
import { withAgentLock } from '../../agents/lock.js'
import { newDesktopTriggerToken } from './token.js'
import type { DesktopTriggerAuthority, DesktopTriggerRecord, DesktopTriggerStore } from './types.js'

export class DesktopTriggerLifecycleError extends Error {
    constructor(readonly status: number, message: string) { super(message); this.name = 'DesktopTriggerLifecycleError' }
}

export function desktopTriggerDefinitionRevision(record: DesktopTriggerRecord | null): string {
    if (!record) return 'absent'
    const { slug, name, description, enabled, methods, connectionId, provider, model, body, token, createdAt } = record
    return createHash('sha256').update(JSON.stringify({ slug, name, description, enabled, methods, connectionId, provider, model, body, token, createdAt })).digest('hex')
}

function slugify(name: string): string {
    const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    if (!DESKTOP_TRIGGER_SLUG_RE.test(slug)) throw new DesktopTriggerLifecycleError(400, 'Trigger name must contain a letter or digit')
    return slug
}

function view(authority: DesktopTriggerAuthority, localAgentId: string, trigger: DesktopTriggerRecord, includeToken = false): DesktopTrigger {
    const { token, ...record } = trigger
    const origin = authority.ingressOrigin()
    return { ...record, revision: desktopTriggerDefinitionRevision(trigger), url: includeToken && origin.enabled && origin.origin && token ? `${origin.origin}/api/desktop/trigger-ingress/${encodeURIComponent(localAgentId)}/${encodeURIComponent(trigger.slug)}/${encodeURIComponent(token)}` : null, ...(includeToken ? { token } : {}) }
}

export function createDesktopTriggerLifecycle(authority: DesktopTriggerAuthority, store: DesktopTriggerStore) {
    const owner = async (id: string, allowDisabled = false) => {
        authority.assertActive()
        if (await store.isRevoked(id)) throw new DesktopTriggerLifecycleError(404, 'Coworker triggers revoked')
        const current = await authority.resolveOwnerByEngineId(id)
        if (current.engineAgentId !== id || current.deleting) throw new DesktopTriggerLifecycleError(409, 'Coworker identity changed')
        if (!allowDisabled && !current.enabled) throw new DesktopTriggerLifecycleError(403, 'Enable this coworker to manage triggers')
        authority.assertActive()
        return current
    }
    async function mutate(id: string, slug: string, kind: 'create' | 'update' | 'rotate' | 'delete', input: { requestId: string; expectedRevision?: string }, prepare: (current: DesktopTriggerRecord | null) => DesktopTriggerRecord | null, admission?: () => Promise<void>): Promise<DesktopTrigger | { deleted: string; revision: string }> {
        if (!DESKTOP_TRIGGER_SLUG_RE.test(slug)) throw new DesktopTriggerLifecycleError(400, 'Invalid trigger')
        return withAgentLock(id, async () => {
            await admission?.()
            const identity = await owner(id)
            const fingerprint = createHash('sha256').update(JSON.stringify({ kind, slug, input })).digest('hex')
            let intent = await store.findIntent(id, input.requestId)
            if (intent && (intent.fingerprint !== fingerprint || intent.slug !== slug || intent.kind !== kind)) throw new DesktopTriggerLifecycleError(409, 'This request belongs to a different trigger change')
            if (intent?.resultJson) {
                const result = JSON.parse(intent.resultJson)
                if (result.interrupted === true) throw new DesktopTriggerLifecycleError(409, 'This earlier change was interrupted. Reopen the trigger and make a new change.')
                return result
            }
            let current = await authority.readTrigger(id, slug)
            if (!intent) {
                if (kind === 'create' && current) throw new DesktopTriggerLifecycleError(409, 'A trigger with this name already exists')
                if (kind !== 'create' && (!current || desktopTriggerDefinitionRevision(current) !== input.expectedRevision)) throw new DesktopTriggerLifecycleError(409, 'Trigger changed since you opened it')
                const prepared = prepare(current)
                const after = prepared ? { ...prepared, body: prepared.body.trim() } : null
                intent = { requestId: input.requestId, fingerprint, kind, slug, before: current, after, revision: after ? desktopTriggerDefinitionRevision(after) : createHash('sha256').update(`${input.requestId}:deleted`).digest('hex'), resultJson: null }
                // A different explicit request may clear an abandoned slot, but never reruns it.
                // The owner lock excludes an in-flight mutation in this engine. If its file CAS
                // already landed, acknowledge it; otherwise close it as interrupted before this
                // new, revision-checked request is admitted.
                const pending = await store.findPendingIntent(id, slug)
                if (pending && pending.requestId !== input.requestId) {
                    const landed = desktopTriggerDefinitionRevision(current) === desktopTriggerDefinitionRevision(pending.after)
                    const acknowledgement = landed
                        ? current ? view(authority, identity.localAgentId, current, true) : { deleted: slug, revision: pending.revision }
                        : { interrupted: true }
                    await store.completeIntent(id, pending.requestId, JSON.stringify(acknowledgement))
                }
                try { await store.reserveIntent(id, intent) } catch { throw new DesktopTriggerLifecycleError(409, 'Another trigger change is awaiting acknowledgement. Retry that change first.') }
            }
            await owner(id)
            current = await authority.readTrigger(id, slug)
            const actual = desktopTriggerDefinitionRevision(current)
            const before = desktopTriggerDefinitionRevision(intent.before), after = desktopTriggerDefinitionRevision(intent.after)
            if (actual !== before && actual !== after) throw new DesktopTriggerLifecycleError(409, 'Trigger was replaced while its change was pending')
            await admission?.()
            if (actual !== after) {
                if (authority.replaceTrigger) current = await authority.replaceTrigger(id, slug, intent.before, intent.after)
                else {
                    // Compatibility for injected adapters; production uses exact file CAS below.
                    if (!intent.after) { await authority.deleteTrigger(id, slug); current = null }
                    else if (kind === 'rotate') current = await authority.rotateTriggerToken(id, slug, intent.after.token)
                    else current = await authority.writeTrigger(id, intent.after)
                }
            }
            const confirmed = await authority.readTrigger(id, slug)
            if (desktopTriggerDefinitionRevision(confirmed) !== after) throw new DesktopTriggerLifecycleError(409, 'Trigger change was not acknowledged. Retry the same change.')
            if ((await owner(id)).localAgentId !== identity.localAgentId) throw new DesktopTriggerLifecycleError(409, 'Coworker identity changed')
            const result = confirmed ? view(authority, identity.localAgentId, confirmed, true) : { deleted: slug, revision: intent.revision }
            await store.completeIntent(id, input.requestId, JSON.stringify(result))
            return result
        })
    }
    return {
        async list(id: string): Promise<DesktopTriggerPublic[]> {
            const identity = await owner(id, true)
            return (await authority.listTriggers(id)).map(record => view(authority, identity.localAgentId, record))
        },
        async get(id: string, slug: string, opts: { includeToken?: boolean } = {}) {
            const identity = await owner(id, true)
            if (!DESKTOP_TRIGGER_SLUG_RE.test(slug)) throw new DesktopTriggerLifecycleError(400, 'Invalid trigger')
            const record = await authority.readTrigger(id, slug)
            if (!record) throw new DesktopTriggerLifecycleError(404, 'Trigger not found')
            return view(authority, identity.localAgentId, record, opts.includeToken === true)
        },
        async create(id: string, raw: DesktopTriggerCreate, admission?: () => Promise<void>): Promise<DesktopTrigger> {
            const input = desktopTriggerCreateSchema.parse(raw), slug = slugify(input.name)
            return mutate(id, slug, 'create', input, () => ({ slug, name: input.name, description: input.description, body: input.body, enabled: input.enabled ?? true, methods: input.methods, connectionId: input.connectionId ?? null, provider: input.provider, model: input.model, token: newDesktopTriggerToken(), createdAt: new Date().toISOString(), fireCount: 0, lastFiredAt: null }), admission) as Promise<DesktopTrigger>
        },
        async update(id: string, slug: string, raw: DesktopTriggerUpdate, admission?: () => Promise<void>): Promise<DesktopTrigger> {
            const input = desktopTriggerUpdateSchema.parse(raw)
            return mutate(id, slug, 'update', input, current => {
                const { requestId: _request, expectedRevision: _revision, ...changes } = input
                return { ...current!, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)), token: current!.token || newDesktopTriggerToken() }
            }, admission) as Promise<DesktopTrigger>
        },
        async rotate(id: string, slug: string, raw: unknown, admission?: () => Promise<void>): Promise<DesktopTrigger> {
            return mutate(id, slug, 'rotate', desktopTriggerMutateSchema.parse(raw), current => ({ ...current!, token: newDesktopTriggerToken() }), admission) as Promise<DesktopTrigger>
        },
        async remove(id: string, slug: string, raw: unknown, admission?: () => Promise<void>): Promise<{ deleted: string; revision: string }> {
            return mutate(id, slug, 'delete', desktopTriggerMutateSchema.parse(raw), () => null, admission) as Promise<{ deleted: string; revision: string }>
        },
        async history(id: string, slug?: string) {
            await owner(id, true)
            const events = await store.listEvents(id, slug, 200)
            return events.map(event => ({ eventId: event.eventId, slug: event.slug, triggerName: event.triggerName, status: event.status, receivedAt: event.receivedAt, finishedAt: event.finishedAt ?? null, localSessionId: event.localSessionId, runId: event.runId, error: event.error, capturedPayload: event.capturedPayload, liveOnly: false }))
        },
        async revokeCoworker(id: string) { await store.revokeOwner(id) },
    }
}
export type DesktopTriggerLifecycle = ReturnType<typeof createDesktopTriggerLifecycle>
