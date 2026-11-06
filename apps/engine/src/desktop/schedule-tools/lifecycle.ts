import { createHash } from 'node:crypto'
import { Cron } from 'croner'
import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M, type DesktopScheduleToolNotice, type DesktopScheduleToolOutcome, type DesktopScheduleToolProjection } from '@rerun/contracts'
import { slugify } from '../../lib/ids.js'
import { withAgentLock } from '../../agents/lock.js'
import { desktopScheduleModelDecision, isIanaTimezone } from './model.js'
import { desktopScheduleDefinitionRevision } from './revision.js'
import { projectScheduleGet, projectScheduleList } from './project.js'
import type { DesktopScheduleDefinition, DesktopScheduleFilePort, DesktopScheduleIntent, DesktopScheduleIntentStore, DesktopScheduleOwner, DesktopScheduleReceipt, DesktopScheduleToolAuthority } from './types.js'

export class DesktopScheduleToolError extends Error {
    readonly outcome: Exclude<DesktopScheduleToolOutcome, 'committed'>
    constructor(outcome: Exclude<DesktopScheduleToolOutcome, 'committed'>, message: string) {
        super(message)
        this.name = 'DesktopScheduleToolError'
        this.outcome = outcome
    }
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,160}$/
const reject = (message: string) => new DesktopScheduleToolError('rejected', message)

export type DesktopScheduleCreateInput = {
    requestId: string
    name: string
    description: string
    body: string
    cron?: string
    runAt?: string
    timezone?: string
    provider?: string
    model?: string
}
export type DesktopScheduleUpdateInput = {
    requestId: string
    expectedRevision: string
    description?: string
    body?: string
    cron?: string
    runAt?: string
    timezone?: string
    enabled?: boolean
    provider?: string
    model?: string
}
export type DesktopScheduleEditInput = { requestId: string; expectedRevision: string; oldString: string; newString: string; replaceAll: boolean }
export type DesktopScheduleDeleteInput = { requestId: string; expectedRevision: string }

function fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function exclusive(cron: string | null, runAt: string | null) {
    if (Boolean(cron) === Boolean(runAt)) throw reject(M.exclusive)
}

function assertTiming(cron: string | null, runAt: string | null, timezone: string | null, requireTimezone: boolean) {
    exclusive(cron, runAt)
    if (requireTimezone && !timezone) throw reject(M.timezone)
    if (timezone && !isIanaTimezone(timezone)) throw reject(M.invalidTimezone(timezone))
    if (cron) {
        try { new Cron(cron, timezone ? { timezone } : undefined) } catch { throw reject(M.invalidCron(cron)) }
    }
    if (runAt && Number.isNaN(new Date(runAt).getTime())) throw reject(M.invalidRunAt(runAt))
}

function assertRunnable(owner: DesktopScheduleOwner, next: DesktopScheduleDefinition | null) {
    if (!next || next.enabled === false) return
    if (!owner.connectedModel) throw reject(M.noModel)
}

export function createDesktopScheduleLifecycle(input: {
    authority: DesktopScheduleToolAuthority
    files: DesktopScheduleFilePort
    store: DesktopScheduleIntentStore
    now?: () => Date
}) {
    const now = input.now ?? (() => new Date())
    const projections = new Map<string, DesktopScheduleToolProjection>()

    function remember(receipt: DesktopScheduleReceipt) {
        const projection: DesktopScheduleToolProjection = {
            outcome: receipt.outcome === 'interrupted' ? 'rejected' : receipt.outcome,
            operation: receipt.operation,
            text: receipt.text,
            slug: receipt.slug,
            revision: receipt.revision,
        }
        projections.set(`${receipt.operation}:${receipt.slug}:${receipt.text}`, projection)
        return projection
    }

    function mapRead(error: unknown): never {
        if (error instanceof DesktopScheduleToolError) throw error
        if (error instanceof Error && error.message === M.fileUnsafe) throw reject(M.fileUnsafe)
        throw error
    }

    async function readOf(engineAgentId: string, slug: string): Promise<DesktopScheduleDefinition | null> {
        try { return await input.files.read(engineAgentId, slug) }
        catch (error) { mapRead(error) }
    }

    async function owner(engineAgentId: string): Promise<DesktopScheduleOwner> {
        input.authority.assertActive()
        const current = await input.authority.resolveOwner(engineAgentId)
        if (current.engineAgentId !== engineAgentId || current.deleting) throw reject(M.deleting)
        if (!current.enabled) throw reject(M.disabled)
        if (current.setupPending) throw reject(M.setup)
        if (!current.scheduleManage) throw reject(M.permission)
        input.authority.assertActive()
        return current
    }

    function notice(identity: DesktopScheduleOwner, slug: string, operation: DesktopScheduleToolNotice['operation'], revision: string): DesktopScheduleToolNotice {
        return { localAgentId: identity.localAgentId, engineAgentId: identity.engineAgentId, slug, operation, outcome: 'committed', revision, at: now().toISOString() }
    }

    async function publish(identity: DesktopScheduleOwner, slug: string, operation: DesktopScheduleToolNotice['operation'], revision: string) {
        if (!input.authority.notify) return
        try { await input.authority.notify(notice(identity, slug, operation, revision)) } catch { /* the receipt is already terminal */ }
    }

    function committed(operation: DesktopScheduleReceipt['operation'], text: string, slug: string, revision: string | null): DesktopScheduleReceipt {
        return { outcome: 'committed', operation, text, slug, revision }
    }

    async function mutate(engineAgentId: string, slug: string, kind: DesktopScheduleIntent['kind'], raw: { requestId: string; expectedRevision?: string }, textFor: (current: DesktopScheduleDefinition | null) => string, prepare: (current: DesktopScheduleDefinition | null) => DesktopScheduleDefinition | null, admission?: () => Promise<void>): Promise<DesktopScheduleReceipt> {
        if (!SLUG_RE.test(slug)) throw reject(M.name)
        return withAgentLock(engineAgentId, async () => {
            await admission?.()
            const identity = await owner(engineAgentId)
            const stamp = fingerprint({ kind, slug, raw })
            let intent = await input.store.findIntent(engineAgentId, raw.requestId)
            if (intent && (intent.fingerprint !== stamp || intent.slug !== slug || intent.kind !== kind)) throw reject(M.conflict)
            if (intent?.resultJson) {
                const stored = JSON.parse(intent.resultJson) as DesktopScheduleReceipt
                if (stored.outcome === 'interrupted') throw reject(stored.text)
                if (stored.outcome === 'cancelled') throw new DesktopScheduleToolError('cancelled', stored.text)
                if (stored.outcome === 'rejected') throw reject(stored.text)
                remember(stored)
                return stored
            }
            let current = await readOf(engineAgentId, slug)
            if (!intent) {
                if (kind === 'create' && current) throw reject(M.exists)
                if (kind !== 'create' && !current) throw reject(M.notFound(slug))
                if (kind !== 'create' && desktopScheduleDefinitionRevision(current) !== raw.expectedRevision) throw reject(M.stale)
                const prepared = prepare(current)
                const after = prepared ? { ...prepared, body: prepared.body.trim() } : null
                assertRunnable(await owner(engineAgentId), after)
                const text = textFor(current)
                intent = {
                    requestId: raw.requestId,
                    fingerprint: stamp,
                    kind,
                    slug,
                    text,
                    before: current,
                    after,
                    revision: desktopScheduleDefinitionRevision(after),
                    resultJson: null,
                }
                const pending = await input.store.findPending(engineAgentId, slug)
                if (pending && pending.requestId !== raw.requestId) {
                    const landed = desktopScheduleDefinitionRevision(current) === desktopScheduleDefinitionRevision(pending.after)
                    const closed: DesktopScheduleReceipt = landed
                        ? committed(pending.kind, pending.text, slug, desktopScheduleDefinitionRevision(current))
                        : { outcome: 'interrupted', operation: pending.kind, text: M.interrupted, slug, revision: desktopScheduleDefinitionRevision(current) }
                    await input.store.complete(engineAgentId, pending.requestId, JSON.stringify(closed))
                }
                try { await input.store.reserve(engineAgentId, intent) } catch { throw reject(M.pending) }
            }
            let writer: DesktopScheduleOwner
            try {
                await admission?.()
                writer = await owner(engineAgentId)
                if (writer.localAgentId !== identity.localAgentId) throw reject(M.deleting)
            } catch (error) {
                const latest = await readOf(engineAgentId, slug)
                const stillPrior = desktopScheduleDefinitionRevision(latest) === desktopScheduleDefinitionRevision(intent.before)
                if (stillPrior && error instanceof DesktopScheduleToolError && (error.message === M.inactive || error.outcome === 'cancelled')) {
                    const closed: DesktopScheduleReceipt = { outcome: error.outcome === 'cancelled' ? 'cancelled' : 'interrupted', operation: kind, text: error.message, slug, revision: desktopScheduleDefinitionRevision(latest) }
                    await input.store.complete(engineAgentId, raw.requestId, JSON.stringify(closed))
                }
                throw error
            }
            current = await readOf(engineAgentId, slug)
            const actual = desktopScheduleDefinitionRevision(current)
            const before = desktopScheduleDefinitionRevision(intent.before)
            const after = desktopScheduleDefinitionRevision(intent.after)
            if (actual !== before && actual !== after) {
                const closed: DesktopScheduleReceipt = { outcome: 'interrupted', operation: kind, text: M.replaced, slug, revision: actual }
                await input.store.complete(engineAgentId, raw.requestId, JSON.stringify(closed))
                throw reject(M.replaced)
            }
            assertRunnable(writer, actual === after ? current : intent.after)
            if (actual !== after) {
                try { await input.files.replace(engineAgentId, slug, intent.before, intent.after, async () => {
                    await admission?.()
                    const latest = await owner(engineAgentId)
                    if (latest.localAgentId !== identity.localAgentId) throw reject(M.deleting)
                    assertRunnable(latest, intent!.after)
                }) }
                catch (error) {
                    if (error instanceof DesktopScheduleToolError) {
                        const closed: DesktopScheduleReceipt = { outcome: error.outcome === 'cancelled' ? 'cancelled' : 'interrupted', operation: kind, text: error.message, slug, revision: before }
                        await input.store.complete(engineAgentId, raw.requestId, JSON.stringify(closed))
                        throw error
                    }
                    if (error instanceof Error && error.message === M.fileUnsafe) throw reject(M.fileUnsafe)
                    throw new DesktopScheduleToolError('uncertain', M.uncertain)
                }
            }
            const confirmed = await readOf(engineAgentId, slug)
            if (desktopScheduleDefinitionRevision(confirmed) !== after) throw new DesktopScheduleToolError('uncertain', M.uncertain)
            if ((await owner(engineAgentId)).localAgentId !== identity.localAgentId) throw reject(M.deleting)
            const receipt = committed(kind, intent.text, slug, after === 'absent' ? null : after)
            await input.store.complete(engineAgentId, raw.requestId, JSON.stringify(receipt))
            if (after !== 'absent') await publish(identity, slug, kind, after)
            else await publish(identity, slug, 'delete', before)
            remember(receipt)
            return receipt
        })
    }

    return {
        projection: (key: string) => projections.get(key) ?? null,
        async list(engineAgentId: string, admission?: () => Promise<void>) {
            await admission?.()
            await owner(engineAgentId)
            try {
                const schedules = await input.files.list(engineAgentId)
                await admission?.()
                await owner(engineAgentId)
                const text = projectScheduleList(schedules, now())
                const receipt = committed('list', text, '', null)
                remember(receipt)
                return receipt
            } catch (error) {
                if (error instanceof DesktopScheduleToolError) throw error
                if (error instanceof Error && error.message === M.fileUnsafe) throw reject(M.fileUnsafe)
                throw reject(M.listUnavailable)
            }
        },
        async get(engineAgentId: string, slug: string, admission?: () => Promise<void>) {
            await admission?.()
            await owner(engineAgentId)
            if (!SLUG_RE.test(slug)) throw reject(M.notFound(slug))
            const schedule = await readOf(engineAgentId, slug)
            await admission?.()
            await owner(engineAgentId)
            if (!schedule) throw reject(M.notFound(slug))
            const receipt = committed('get', projectScheduleGet(schedule, now()), slug, desktopScheduleDefinitionRevision(schedule))
            remember(receipt)
            return receipt
        },
        async create(engineAgentId: string, raw: DesktopScheduleCreateInput, admission?: () => Promise<void>) {
            const slug = slugify(raw.name)
            if (!SLUG_RE.test(slug)) throw reject(M.name)
            if (raw.body.length > 64000) throw reject(M.tooLong)
            if (!raw.cron && !raw.runAt) throw reject(M.neither)
            if (raw.cron && raw.runAt) throw reject(M.both)
            return mutate(engineAgentId, slug, 'create', raw, () => M.created(slug), () => {
                const timezone = raw.timezone ?? null
                const cron = raw.cron ?? null
                const runAt = raw.runAt ?? null
                assertTiming(cron, runAt, timezone, true)
                return {
                    slug,
                    name: raw.name.trim(),
                    description: raw.description.trim(),
                    enabled: true,
                    cron,
                    runAt,
                    timezone,
                    lastRunAt: null,
                    connectionId: null,
                    provider: null,
                    model: null,
                    body: raw.body.trim(),
                    createdAt: now().toISOString(),
                }
            }, async () => {
                await admission?.()
                const current = await input.authority.resolveOwner(engineAgentId)
                const named = desktopScheduleModelDecision({ provider: raw.provider, model: raw.model, connected: current.connectedModel, loneProvider: 'ignore' })
                if (!named.ok) throw reject(named.refusal)
            })
        },
        async update(engineAgentId: string, slug: string, raw: DesktopScheduleUpdateInput, admission?: () => Promise<void>) {
            if (raw.provider && !raw.model) throw reject(M.providerWithoutModel)
            if (raw.cron && raw.runAt) throw reject(M.both)
            return mutate(engineAgentId, slug, 'update', raw, current => {
                if (raw.body !== undefined && current && raw.body !== current.body) return M.replacedBody(slug, current.body.length, raw.body.length)
                return M.updated(slug)
            }, current => {
                if (!current) throw reject(M.stale)
                const next: DesktopScheduleDefinition = { ...current, description: raw.description ?? current.description, body: raw.body ?? current.body, timezone: raw.timezone ?? current.timezone, enabled: raw.enabled ?? current.enabled }
                if (raw.cron !== undefined) { next.cron = raw.cron; next.runAt = null }
                if (raw.runAt !== undefined) { next.runAt = raw.runAt; next.cron = null }
                if (raw.body !== undefined && raw.body.length > 64000) throw reject(M.tooLong)
                if (raw.model) {
                    next.connectionId = null
                    next.provider = null
                    next.model = null
                }
                assertTiming(next.cron, next.runAt, next.timezone, false)
                if ((next.cron || next.runAt) && next.timezone && !isIanaTimezone(next.timezone)) throw reject(M.invalidTimezone(next.timezone))
                return next
            }, async () => {
                await admission?.()
                const current = await input.authority.resolveOwner(engineAgentId)
                const named = desktopScheduleModelDecision({ provider: raw.provider, model: raw.model, connected: current.connectedModel, loneProvider: 'refuse' })
                if (!named.ok) throw reject(named.refusal)
            })
        },
        async edit(engineAgentId: string, slug: string, raw: DesktopScheduleEditInput, admission?: () => Promise<void>) {
            if (!raw.oldString) throw reject(M.emptyExcerpt)
            if (raw.oldString === raw.newString) throw reject(M.identical)
            return mutate(engineAgentId, slug, 'edit', raw, current => {
                const count = current ? current.body.split(raw.oldString).length - 1 : 0
                return M.edited(slug, count)
            }, current => {
                if (!current) throw reject(M.stale)
                const count = current.body.split(raw.oldString).length - 1
                if (count === 0) throw reject(M.missingExcerpt(slug))
                if (count > 1 && !raw.replaceAll) throw reject(M.ambiguous(slug, count))
                const body = raw.replaceAll ? current.body.split(raw.oldString).join(raw.newString) : current.body.replace(raw.oldString, raw.newString)
                if (body.length > 64000) throw reject(M.tooLong)
                assertTiming(current.cron, current.runAt, current.timezone, false)
                return { ...current, body }
            }, admission)
        },
        remove(engineAgentId: string, slug: string, raw: DesktopScheduleDeleteInput, admission?: () => Promise<void>) {
            return mutate(engineAgentId, slug, 'delete', raw, () => M.deleted(slug), () => null, admission)
        },
        /** Seal landed writes and divergent pending intents. Does not apply an unlanded write or start a run. */
        async recover(engineAgentId: string) {
            return withAgentLock(engineAgentId, async () => {
                const pending = await input.store.listPending(engineAgentId)
                let reconciled = 0, waiting = 0, interrupted = 0
                for (const intent of pending) {
                    const current = await readOf(engineAgentId, intent.slug)
                    const actual = desktopScheduleDefinitionRevision(current)
                    const after = desktopScheduleDefinitionRevision(intent.after)
                    if (actual === after) {
                        const receipt = committed(intent.kind, intent.text, intent.slug, after === 'absent' ? null : after)
                        await input.store.complete(engineAgentId, intent.requestId, JSON.stringify(receipt))
                        const identity = await input.authority.resolveOwner(engineAgentId).catch(() => null)
                        if (identity && after !== 'absent') await publish(identity, intent.slug, intent.kind, after)
                        else if (identity) await publish(identity, intent.slug, 'delete', desktopScheduleDefinitionRevision(intent.before))
                        reconciled += 1
                    } else if (actual === desktopScheduleDefinitionRevision(intent.before)) waiting += 1
                    else {
                        const receipt: DesktopScheduleReceipt = { outcome: 'interrupted', operation: intent.kind, text: M.interrupted, slug: intent.slug, revision: actual }
                        await input.store.complete(engineAgentId, intent.requestId, JSON.stringify(receipt))
                        interrupted += 1
                    }
                }
                return { reconciled, waiting, interrupted }
            })
        },
    }
}

export type DesktopScheduleLifecycle = ReturnType<typeof createDesktopScheduleLifecycle>
