import {
    DESKTOP_TRIGGER_SLUG_RE,
    desktopTriggerCreateSchema,
    desktopTriggerMutateSchema,
    desktopTriggerUpdateSchema,
    type DesktopTrigger,
    type DesktopTriggerCreate,
    type DesktopTriggerPublic,
    type DesktopTriggerUpdate,
} from '@rerun/contracts'
import { newDesktopTriggerToken } from './token.js'
import type { DesktopTriggerAuthority, DesktopTriggerRecord, DesktopTriggerStore } from './types.js'

export class DesktopTriggerLifecycleError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'DesktopTriggerLifecycleError'
    }
}

function slugifyName(name: string): string {
    const slug = name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
    if (!DESKTOP_TRIGGER_SLUG_RE.test(slug)) throw new DesktopTriggerLifecycleError(400, 'trigger name must contain at least one letter or digit')
    return slug
}

function toPublic(trigger: DesktopTriggerRecord, revision: string, url: string | null, includeToken: boolean): DesktopTrigger {
    return {
        slug: trigger.slug,
        name: trigger.name,
        description: trigger.description,
        enabled: trigger.enabled,
        methods: trigger.methods,
        lastFiredAt: trigger.lastFiredAt,
        fireCount: trigger.fireCount,
        connectionId: trigger.connectionId,
        provider: trigger.provider as DesktopTrigger['provider'],
        model: trigger.model,
        body: trigger.body,
        createdAt: trigger.createdAt,
        revision,
        url,
        ...(includeToken ? { token: trigger.token } : {}),
    }
}

function toModelSafe(trigger: DesktopTriggerRecord, revision: string): DesktopTriggerPublic {
    const { token: _t, ...rest } = toPublic(trigger, revision, null, false)
    return rest
}

function buildUrl(origin: string | null, engineAgentId: string, slug: string, token: string): string | null {
    if (!origin || !token) return null
    return `${origin.replace(/\/$/, '')}/api/t/${encodeURIComponent(engineAgentId)}/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`
}

async function requireOwner(authority: DesktopTriggerAuthority, store: DesktopTriggerStore, engineAgentId: string) {
    authority.assertActive()
    if (await store.isRevoked(engineAgentId)) throw new DesktopTriggerLifecycleError(404, 'Coworker triggers revoked')
    const owner = await authority.resolveOwnerByEngineId(engineAgentId)
    if (owner.deleting) throw new DesktopTriggerLifecycleError(409, 'This coworker is being deleted')
    if (!owner.enabled) throw new DesktopTriggerLifecycleError(403, 'Enable this coworker to manage triggers')
    await authority.assertTriggerGrant(engineAgentId)
    authority.assertActive()
    return owner
}

export function createDesktopTriggerLifecycle(authority: DesktopTriggerAuthority, store: DesktopTriggerStore) {
    async function withIdempotency<T>(engineAgentId: string, requestId: string, kind: 'create' | 'update' | 'rotate' | 'delete', run: () => Promise<{ slug: string; revisionBefore: string | null; revisionAfter: string | null; result: T }>): Promise<T> {
        const prior = await store.findMutation(engineAgentId, requestId)
        if (prior) {
            if (prior.kind !== kind) throw new DesktopTriggerLifecycleError(409, 'Request id was used for a different trigger mutation')
            return JSON.parse(prior.resultJson) as T
        }
        const produced = await run()
        await store.rememberMutation({
            engineAgentId,
            requestId,
            kind,
            slug: produced.slug,
            revisionBefore: produced.revisionBefore,
            revisionAfter: produced.revisionAfter,
            resultJson: JSON.stringify(produced.result),
        })
        const confirmed = await store.findMutation(engineAgentId, requestId)
        if (!confirmed) throw new DesktopTriggerLifecycleError(500, 'Trigger mutation acknowledgement failed')
        // A concurrent winner may have stored first — always return the durable receipt.
        return JSON.parse(confirmed.resultJson) as T
    }

    return {
        async list(engineAgentId: string): Promise<DesktopTriggerPublic[]> {
            await requireOwner(authority, store, engineAgentId)
            const triggers = await authority.listTriggers(engineAgentId)
            const out: DesktopTriggerPublic[] = []
            for (const trigger of triggers) {
                const revision = (await store.getRevision(engineAgentId, trigger.slug)) ?? (await store.bumpRevision(engineAgentId, trigger.slug))
                out.push(toModelSafe(trigger, revision))
            }
            return out
        },

        async get(engineAgentId: string, slug: string, opts: { includeToken?: boolean } = {}): Promise<DesktopTrigger> {
            await requireOwner(authority, store, engineAgentId)
            const trigger = await authority.readTrigger(engineAgentId, slug)
            if (!trigger) throw new DesktopTriggerLifecycleError(404, 'trigger not found')
            const revision = (await store.getRevision(engineAgentId, slug)) ?? (await store.bumpRevision(engineAgentId, slug))
            const origin = authority.ingressOrigin()
            const url = origin.enabled ? buildUrl(origin.origin, engineAgentId, trigger.slug, trigger.token) : null
            return toPublic(trigger, revision, url, opts.includeToken === true)
        },

        async create(engineAgentId: string, raw: DesktopTriggerCreate): Promise<DesktopTrigger> {
            const input = desktopTriggerCreateSchema.parse(raw)
            await requireOwner(authority, store, engineAgentId)
            const slug = slugifyName(input.name)
            return withIdempotency(engineAgentId, input.requestId, 'create', async () => {
                const existing = await authority.readTrigger(engineAgentId, slug)
                if (existing) {
                    // Lost ACK of a successful create: same requestId handled above; a different create colliding on slug fails.
                    throw new DesktopTriggerLifecycleError(409, 'A trigger with this name already exists')
                }
                const written = await authority.writeTrigger(engineAgentId, {
                    name: input.name,
                    description: input.description,
                    body: input.body,
                    methods: input.methods,
                    enabled: input.enabled ?? true,
                    connectionId: input.connectionId ?? null,
                    provider: input.provider,
                    model: input.model,
                    token: newDesktopTriggerToken(),
                })
                const revision = await store.bumpRevision(engineAgentId, written.slug)
                const origin = authority.ingressOrigin()
                const result = toPublic(written, revision, origin.enabled ? buildUrl(origin.origin, engineAgentId, written.slug, written.token) : null, true)
                return { slug: written.slug, revisionBefore: null, revisionAfter: revision, result }
            })
        },

        async update(engineAgentId: string, slug: string, raw: DesktopTriggerUpdate): Promise<DesktopTrigger> {
            const input = desktopTriggerUpdateSchema.parse(raw)
            await requireOwner(authority, store, engineAgentId)
            return withIdempotency(engineAgentId, input.requestId, 'update', async () => {
                const current = await authority.readTrigger(engineAgentId, slug)
                if (!current) throw new DesktopTriggerLifecycleError(404, 'trigger not found')
                const revisionBefore = (await store.getRevision(engineAgentId, slug)) ?? (await store.bumpRevision(engineAgentId, slug))
                if (revisionBefore !== input.expectedRevision) throw new DesktopTriggerLifecycleError(409, 'Trigger changed since you opened it')
                const written = await authority.writeTrigger(engineAgentId, {
                    name: current.name,
                    description: input.description ?? current.description,
                    body: input.body ?? current.body,
                    methods: input.methods ?? current.methods,
                    enabled: input.enabled ?? current.enabled,
                    connectionId: input.connectionId !== undefined ? input.connectionId : current.connectionId,
                    provider: input.provider !== undefined ? input.provider : current.provider,
                    model: input.model !== undefined ? input.model : current.model,
                    token: current.token || newDesktopTriggerToken(),
                })
                const revisionAfter = await store.bumpRevision(engineAgentId, slug)
                const origin = authority.ingressOrigin()
                const result = toPublic(written, revisionAfter, origin.enabled ? buildUrl(origin.origin, engineAgentId, written.slug, written.token) : null, true)
                return { slug, revisionBefore, revisionAfter, result }
            })
        },

        async rotate(engineAgentId: string, slug: string, raw: unknown): Promise<DesktopTrigger> {
            const input = desktopTriggerMutateSchema.parse(raw)
            await requireOwner(authority, store, engineAgentId)
            return withIdempotency(engineAgentId, input.requestId, 'rotate', async () => {
                const current = await authority.readTrigger(engineAgentId, slug)
                if (!current) throw new DesktopTriggerLifecycleError(404, 'trigger not found')
                const revisionBefore = (await store.getRevision(engineAgentId, slug)) ?? (await store.bumpRevision(engineAgentId, slug))
                if (revisionBefore !== input.expectedRevision) throw new DesktopTriggerLifecycleError(409, 'Trigger changed since you opened it')
                const nextToken = newDesktopTriggerToken()
                const written = await authority.rotateTriggerToken(engineAgentId, slug, nextToken)
                const revisionAfter = await store.bumpRevision(engineAgentId, slug)
                const origin = authority.ingressOrigin()
                const result = toPublic(written, revisionAfter, origin.enabled ? buildUrl(origin.origin, engineAgentId, written.slug, written.token) : null, true)
                return { slug, revisionBefore, revisionAfter, result }
            })
        },

        async remove(engineAgentId: string, slug: string, raw: unknown): Promise<{ deleted: string; revision: string }> {
            const input = desktopTriggerMutateSchema.parse(raw)
            await requireOwner(authority, store, engineAgentId)
            return withIdempotency(engineAgentId, input.requestId, 'delete', async () => {
                const current = await authority.readTrigger(engineAgentId, slug)
                if (!current) throw new DesktopTriggerLifecycleError(404, 'trigger not found')
                const revisionBefore = (await store.getRevision(engineAgentId, slug)) ?? (await store.bumpRevision(engineAgentId, slug))
                if (revisionBefore !== input.expectedRevision) throw new DesktopTriggerLifecycleError(409, 'Trigger changed since you opened it — not deleting a replacement')
                await authority.deleteTrigger(engineAgentId, slug)
                const revisionAfter = await store.bumpRevision(engineAgentId, slug)
                const result = { deleted: slug, revision: revisionAfter }
                return { slug, revisionBefore, revisionAfter, result }
            })
        },

        /** Historical runs remain listable after delete/disable via the event store. */
        async history(engineAgentId: string, slug?: string) {
            await requireOwner(authority, store, engineAgentId)
            const events = await store.listEvents(engineAgentId, slug, 200)
            return events.map(event => ({
                eventId: event.eventId,
                slug: event.slug,
                triggerName: event.triggerName,
                status: event.status,
                receivedAt: event.receivedAt,
                finishedAt: event.status === 'running' || event.status === 'accepted' ? null : event.receivedAt,
                localSessionId: event.localSessionId,
                runId: event.runId,
                error: event.error,
                capturedPayload: event.capturedPayload,
                liveOnly: false,
            }))
        },

        async revokeCoworker(engineAgentId: string): Promise<void> {
            await store.revokeOwner(engineAgentId)
        },
    }
}

export type DesktopTriggerLifecycle = ReturnType<typeof createDesktopTriggerLifecycle>
