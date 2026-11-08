import { createHash, createHmac } from 'node:crypto'
import {
    CONNECTION_TOKEN_KEY,
    desktopApiCanonicalJson,
    desktopApiConnectionIdSchema,
    desktopApiConnectionRevisionSchema,
    desktopApiExecutionSnapshotSchema,
    desktopApiMutationReceiptSchema,
    desktopApiMutationResultSchema,
    desktopApiRemovalPlanSchema,
    type BoxDefaultModel,
    type ConnectionUsage,
    type CreateConnectionInput,
    type DesktopApiConnectionCatalog,
    type DesktopApiConnectionView,
    type DesktopApiCreateInput,
    type DesktopApiCredentialInput,
    type DesktopApiExecutionSnapshot,
    type DesktopApiModelsInput,
    type DesktopApiMutationKind,
    type DesktopApiMutationReceipt,
    type DesktopApiMutationResult,
    type DesktopApiPendingRun,
    type DesktopApiRemovalPlan,
    type DesktopApiRemovalResult,
    type DesktopApiRemoveInput,
    type DesktopApiRenameInput,
    type DesktopApiSelectInput,
    type UpdateConnectionInput,
    type UpdateConnectionKeysInput,
} from '@rerun/contracts'
import { toSummary } from '../../connections/loader.js'
import { defaultModelOf } from '../../agents/availability.js'
import type { LoadedConnection } from '../../connections/types.js'
import type { DesktopApiConnectionReceiptRecord, DesktopApiConnectionStore } from './store.js'

export type DesktopApiConnectionAuthority = {
    workspaceId: number
    list(): Promise<LoadedConnection[]>
    get(connectionId: string): Promise<LoadedConnection | null>
    create(input: CreateConnectionInput, connectionId: string): Promise<LoadedConnection>
    patch(connectionId: string, patch: UpdateConnectionInput): Promise<LoadedConnection>
    updateKeys(connectionId: string, input: UpdateConnectionKeysInput): Promise<string[]>
    usage(connectionId: string): Promise<ConnectionUsage>
    release(connectionId: string): Promise<ConnectionUsage>
    delete(connectionId: string): Promise<void>
    readDefault(): Promise<BoxDefaultModel | null>
    writeDefault(next: BoxDefaultModel): Promise<BoxDefaultModel>
    clearDefault(): Promise<void>
    pendingRuns(connectionId: string): Promise<DesktopApiPendingRun[]>
    stopAndDrain?(connectionId: string): Promise<void>
    withMutation?<T>(effect: () => Promise<T>): Promise<T>
    removalAvailable?(): boolean
    withRemoval?<T>(connectionId: string, effect: () => Promise<T>): Promise<T>
}

export class DesktopApiConnectionRefusal extends Error {}

type Applied = { receipt: DesktopApiMutationReceipt; result: DesktopApiMutationResult }
type ReservedReceiptRecord = DesktopApiConnectionReceiptRecord & {
    receipt: DesktopApiMutationReceipt & { connectionId: string; connectionRevision: string }
}
type MutationInput = {
    kind: DesktopApiMutationKind
    workspaceId: number
    connectionId: string
    revision: string
    requestId: string
    input: unknown
    initial?: { connection: LoadedConnection | null; catalog?: DesktopApiConnectionCatalog; removal?: DesktopApiRemovalResult }
    apply: () => Promise<Applied>
    reconcile: (previous: ReservedReceiptRecord) => Promise<Applied | null>
}

const allowed = new Set(['anthropic', 'openai', 'google', 'openrouter'])

function publicInput(input: unknown): { body: unknown; secret: string | null } {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('secret' in input)) return { body: input, secret: null }
    const record = input as Record<string, unknown>
    const secret = record.secret
    const body = { ...record }
    delete body.secret
    return { body, secret: typeof secret === 'string' && secret.length > 0 ? secret : null }
}

/** HMAC under the desktop custody key. The stored digest is not a naked hash of the secret. */
export function desktopApiConnectionFingerprint(input: unknown, key: Buffer | null): string {
    const { body, secret } = publicInput(input)
    const canonical = desktopApiCanonicalJson(body)
    if (secret !== null) {
        if (!key || key.length !== 32) throw new DesktopApiConnectionRefusal('Credential custody is unavailable.')
        const secretTerm = createHmac('sha256', key).update('desktop-api-connection-secret-v1\0').update(secret).digest()
        return createHmac('sha256', key).update('desktop-api-connection-request-v1\0').update(canonical).update(secretTerm).digest('hex')
    }
    if (key && key.length === 32) return createHmac('sha256', key).update('desktop-api-connection-request-v1\0').update(canonical).digest('hex')
    return createHash('sha256').update(canonical).digest('hex')
}

export function createDesktopApiConnectionService({ authority, store, connectionId, revision, now, custodyKey }: {
    authority: DesktopApiConnectionAuthority
    store: DesktopApiConnectionStore
    connectionId: () => string
    revision: () => string
    now: () => Date
    custodyKey?: () => Buffer | null
}) {
    const fingerprint = (input: unknown) => desktopApiConnectionFingerprint(input, custodyKey ? custodyKey() : null)
    const view = async (connection: LoadedConnection): Promise<DesktopApiConnectionView> => ({
        version: 1,
        workspaceId: authority.workspaceId,
        connectionId: desktopApiConnectionIdSchema.parse(connection.id),
        revision: await store.revision(authority.workspaceId, desktopApiConnectionIdSchema.parse(connection.id)),
        provider: connection.config.provider as DesktopApiConnectionView['provider'],
        name: connection.config.name,
        models: connection.config.models,
        extraModels: connection.config.extraModels,
        ...(connection.config.baseUrl !== undefined ? { baseUrl: connection.config.baseUrl } : {}),
        connected: toSummary(connection).connected,
        credentialRejected: toSummary(connection).credentialRejected,
        createdAt: connection.config.createdAt,
    })
    const catalog = async (): Promise<DesktopApiConnectionCatalog> => ({
        version: 1,
        workspaceId: authority.workspaceId,
        connections: await Promise.all((await authority.list()).filter(connection => allowed.has(connection.config.provider)).map(view)),
        default: await authority.readDefault(),
    })
    const receipt = (kind: DesktopApiMutationKind, status: DesktopApiMutationReceipt['status'], workspaceId: number, id: string, nextRevision: string, requestId: string, input: unknown): DesktopApiMutationReceipt => desktopApiMutationReceiptSchema.parse({
        version: 1,
        requestId,
        kind,
        status,
        workspaceId,
        connectionId: id,
        connectionRevision: nextRevision,
        fingerprint: fingerprint(input),
        message: status === 'saved' ? 'Connection mutation saved.' : status === 'refused' ? 'Connection mutation refused before the effect.' : 'Connection mutation outcome is uncertain. It will not be repeated automatically.',
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
    })
    const result = async (kind: DesktopApiMutationKind, status: DesktopApiMutationResult['status'], workspaceId: number, id: string, nextRevision: string, requestId: string, input: unknown, initial: MutationInput['initial'], recovered = false): Promise<Applied> => {
        const currentReceipt = receipt(kind, status, workspaceId, id, nextRevision, requestId, input)
        return {
            receipt: currentReceipt,
            result: desktopApiMutationResultSchema.parse({
                status,
                recovered,
                receipt: currentReceipt,
                connection: initial?.connection ? await view(initial.connection) : null,
                ...(initial?.catalog ? { catalog: initial.catalog } : {}),
                ...(initial?.removal ? { removal: initial.removal } : {}),
            }),
        }
    }
    const uncertain = (input: MutationInput, recovered: boolean): Promise<Applied> => result(input.kind, 'uncertain', input.workspaceId, input.connectionId, input.revision, input.requestId, input.input, input.initial ?? { connection: null }, recovered)

    function refusedUnstored(input: MutationInput): DesktopApiMutationResult {
        const { body } = publicInput(input.input)
        const currentReceipt = desktopApiMutationReceiptSchema.parse({
            version: 1,
            requestId: input.requestId,
            kind: input.kind,
            status: 'refused',
            workspaceId: input.workspaceId,
            connectionId: input.connectionId,
            connectionRevision: input.revision,
            fingerprint: createHash('sha256').update(desktopApiCanonicalJson(body)).digest('hex'),
            message: 'Credential custody is unavailable. Nothing was saved.',
            createdAt: now().toISOString(),
            updatedAt: now().toISOString(),
        })
        return desktopApiMutationResultSchema.parse({ status: 'refused', recovered: false, receipt: currentReceipt, connection: null })
    }

    async function mutate(input: MutationInput): Promise<DesktopApiMutationResult> {
        let initialReceipt: DesktopApiMutationReceipt
        try {
            initialReceipt = receipt(input.kind, 'uncertain', input.workspaceId, input.connectionId, input.revision, input.requestId, input.input)
        } catch (error) {
            if (error instanceof DesktopApiConnectionRefusal) return refusedUnstored(input)
            throw error
        }
        const { created, record: previous } = await store.reserve(initialReceipt, null)
        if (!created) {
            if (previous.receipt.kind !== input.kind || previous.receipt.workspaceId !== input.workspaceId
                || input.kind !== 'create' && previous.receipt.connectionId !== input.connectionId) throw new Error('API connection request identity changed')
            if (previous.receipt.status === 'saved' && previous.result) return { ...previous.result, recovered: true }
            if (previous.receipt.status === 'refused' && previous.result) return { ...previous.result, recovered: true }
            const previousId = desktopApiConnectionIdSchema.safeParse(previous.receipt.connectionId)
            const previousRevision = desktopApiConnectionRevisionSchema.safeParse(previous.receipt.connectionRevision)
            if (!previousId.success || !previousRevision.success) return desktopApiMutationResultSchema.parse({
                status: 'uncertain', recovered: true, connection: null,
                receipt: { ...previous.receipt, status: 'uncertain', message: 'The original connection reservation is incomplete. It will not be repeated automatically.', updatedAt: now().toISOString() },
            })
            const reserved = { ...previous, receipt: { ...previous.receipt, connectionId: previousId.data, connectionRevision: previousRevision.data } }
            const reconciled = await input.reconcile(reserved)
            if (reconciled) {
                reconciled.receipt = { ...reconciled.receipt, createdAt: previous.receipt.createdAt }
                reconciled.result = { ...reconciled.result, receipt: reconciled.receipt }
                await store.finish(reconciled.receipt, reconciled.result)
                return { ...reconciled.result, recovered: true }
            }
            // Preserve the original reservation when the effect still cannot be proved.
            return (await uncertain({ ...input, connectionId: previousId.data, revision: previousRevision.data }, true)).result
        }
        const failed = async (error: unknown): Promise<DesktopApiMutationResult> => {
            if (error instanceof DesktopApiConnectionRefusal || error instanceof Error && error.name === 'AbortError') {
                const refused = await result(input.kind, 'refused', input.workspaceId, input.connectionId, input.revision, input.requestId, input.input, input.initial ?? { connection: null })
                await store.finish(refused.receipt, refused.result).catch(() => {})
                return refused.result
            }
            const pending = await uncertain(input, false)
            await store.finish(pending.receipt, pending.result).catch(() => {})
            return pending.result
        }
        const apply = async (): Promise<DesktopApiMutationResult> => {
            try {
                const applied = await input.apply()
                await store.finish(applied.receipt, applied.result)
                return applied.result
            } catch (error) { return failed(error) }
        }
        if (input.kind !== 'remove' && authority.withMutation) {
            try { return await authority.withMutation(apply) }
            catch (error) { return failed(error) } // Admission itself refused before an effect.
        }
        return apply()
    }

    async function current(id: string, expectedRevision: string): Promise<LoadedConnection> {
        const connection = await authority.get(id)
        if (!connection || !allowed.has(connection.config.provider)) throw new DesktopApiConnectionRefusal('Connection not found.')
        const currentRevision = await store.revision(authority.workspaceId, desktopApiConnectionIdSchema.parse(id))
        if (currentRevision !== desktopApiConnectionRevisionSchema.parse(expectedRevision)) throw new DesktopApiConnectionRefusal('This connection changed. Reload it before saving.')
        return connection
    }

    async function create(input: DesktopApiCreateInput, signal?: AbortSignal): Promise<DesktopApiMutationResult> {
        if (input.workspaceId !== authority.workspaceId) throw new DesktopApiConnectionRefusal('This connection belongs to another workspace.')
        const id = connectionId()
        const nextRevision = revision()
        const keys = { [CONNECTION_TOKEN_KEY[input.provider]]: input.secret }
        const operation: MutationInput = {
            kind: 'create', workspaceId: input.workspaceId, connectionId: id, revision: nextRevision, requestId: input.requestId, input,
            apply: async () => {
                signal?.throwIfAborted()
                const created = await authority.create({ name: input.name, provider: input.provider, models: input.models, extraModels: input.extraModels, ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}), keys }, id)
                await store.setRevision(input.workspaceId, desktopApiConnectionIdSchema.parse(id), null, nextRevision)
                return result('create', 'saved', input.workspaceId, id, nextRevision, input.requestId, input, { connection: created, catalog: await catalog() })
            },
            reconcile: async previous => {
                const id = previous.receipt.connectionId
                const nextRevision = previous.receipt.connectionRevision
                const existing = await authority.get(id)
                if (!existing || existing.config.name !== input.name || existing.config.provider !== input.provider || JSON.stringify(existing.config.models) !== JSON.stringify(input.models) || JSON.stringify(existing.config.extraModels) !== JSON.stringify(input.extraModels) || existing.config.baseUrl !== input.baseUrl || existing.env[CONNECTION_TOKEN_KEY[input.provider]] !== input.secret) return null
                if (await store.revision(input.workspaceId, desktopApiConnectionIdSchema.parse(id)) !== nextRevision) return null
                return result('create', 'saved', input.workspaceId, id, nextRevision, input.requestId, input, { connection: existing, catalog: await catalog() }, true)
            },
        }
        return mutate(operation)
    }

    async function rename(input: DesktopApiRenameInput, signal?: AbortSignal): Promise<DesktopApiMutationResult> {
        if (input.workspaceId !== authority.workspaceId) throw new DesktopApiConnectionRefusal('This connection belongs to another workspace.')
        const nextRevision = revision()
        const operation: MutationInput = {
            kind: 'rename', workspaceId: input.workspaceId, connectionId: input.connectionId, revision: nextRevision, requestId: input.requestId, input,
            apply: async () => {
                await current(input.connectionId, input.expectedRevision)
                signal?.throwIfAborted()
                const updated = await authority.patch(input.connectionId, { name: input.name })
                await store.setRevision(input.workspaceId, input.connectionId, input.expectedRevision, nextRevision)
                return result('rename', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: updated, catalog: await catalog() })
            },
            reconcile: async previous => {
                const nextRevision = previous.receipt.connectionRevision
                const existing = await authority.get(input.connectionId)
                if (!existing || existing.config.name !== input.name || await store.revision(input.workspaceId, input.connectionId) !== nextRevision) return null
                return result('rename', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: existing, catalog: await catalog() }, true)
            },
        }
        return mutate(operation)
    }

    async function models(input: DesktopApiModelsInput, signal?: AbortSignal): Promise<DesktopApiMutationResult> {
        if (input.workspaceId !== authority.workspaceId) throw new DesktopApiConnectionRefusal('This connection belongs to another workspace.')
        const nextRevision = revision()
        const operation: MutationInput = {
            kind: 'models', workspaceId: input.workspaceId, connectionId: input.connectionId, revision: nextRevision, requestId: input.requestId, input,
            apply: async () => {
                const existing = await current(input.connectionId, input.expectedRevision)
                const selectedDefault = input.expectedDefault ?? await authority.readDefault()
                if (selectedDefault?.connectionId === input.connectionId && ![...input.models, ...input.extraModels].includes(selectedDefault.model)) throw new DesktopApiConnectionRefusal('Choose another default before removing this model.')
                signal?.throwIfAborted()
                const updated = await authority.patch(input.connectionId, { models: input.models, extraModels: input.extraModels })
                await store.setRevision(input.workspaceId, input.connectionId, input.expectedRevision, nextRevision)
                return result('models', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: updated, catalog: await catalog() })
            },
            reconcile: async previous => {
                const nextRevision = previous.receipt.connectionRevision
                const existing = await authority.get(input.connectionId)
                if (!existing || JSON.stringify(existing.config.models) !== JSON.stringify(input.models) || JSON.stringify(existing.config.extraModels) !== JSON.stringify(input.extraModels) || await store.revision(input.workspaceId, input.connectionId) !== nextRevision) return null
                return result('models', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: existing, catalog: await catalog() }, true)
            },
        }
        return mutate(operation)
    }

    async function credential(input: DesktopApiCredentialInput, signal?: AbortSignal): Promise<DesktopApiMutationResult> {
        if (input.workspaceId !== authority.workspaceId) throw new DesktopApiConnectionRefusal('This connection belongs to another workspace.')
        const nextRevision = revision()
        const operation: MutationInput = {
            kind: 'credential', workspaceId: input.workspaceId, connectionId: input.connectionId, revision: nextRevision, requestId: input.requestId, input,
            apply: async () => {
                const existing = await current(input.connectionId, input.expectedRevision)
                signal?.throwIfAborted()
                await authority.updateKeys(input.connectionId, { set: { [CONNECTION_TOKEN_KEY[existing.config.provider]]: input.secret }, remove: [] })
                await store.setRevision(input.workspaceId, input.connectionId, input.expectedRevision, nextRevision)
                return result('credential', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: (await authority.get(input.connectionId))!, catalog: await catalog() })
            },
            reconcile: async previous => {
                const nextRevision = previous.receipt.connectionRevision
                const existing = await authority.get(input.connectionId)
                if (!existing || existing.env[CONNECTION_TOKEN_KEY[existing.config.provider]] !== input.secret || await store.revision(input.workspaceId, input.connectionId) !== nextRevision) return null
                return result('credential', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: existing, catalog: await catalog() }, true)
            },
        }
        return mutate(operation)
    }

    async function select(input: DesktopApiSelectInput, signal?: AbortSignal): Promise<DesktopApiMutationResult> {
        if (input.workspaceId !== authority.workspaceId) throw new DesktopApiConnectionRefusal('This connection belongs to another workspace.')
        const nextRevision = revision()
        const operation: MutationInput = {
            kind: 'select', workspaceId: input.workspaceId, connectionId: input.connectionId, revision: nextRevision, requestId: input.requestId, input,
            apply: async () => {
                const existing = await current(input.connectionId, input.expectedRevision)
                if (![...existing.config.models, ...existing.config.extraModels].includes(input.model)) throw new DesktopApiConnectionRefusal('Choose a model offered by this connection.')
                signal?.throwIfAborted()
                await authority.writeDefault({ connectionId: input.connectionId, model: input.model, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) })
                await store.setRevision(input.workspaceId, input.connectionId, input.expectedRevision, nextRevision)
                return result('select', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: (await authority.get(input.connectionId))!, catalog: await catalog() })
            },
            reconcile: async previous => {
                const nextRevision = previous.receipt.connectionRevision
                const existing = await authority.get(input.connectionId)
                const selected = await authority.readDefault()
                if (!existing || selected?.connectionId !== input.connectionId || selected.model !== input.model || selected.reasoningEffort !== input.reasoningEffort || await store.revision(input.workspaceId, input.connectionId) !== nextRevision) return null
                return result('select', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: existing, catalog: await catalog() }, true)
            },
        }
        return mutate(operation)
    }

    async function removalPlan(workspaceId: number, id: string): Promise<DesktopApiRemovalPlan> {
        if (workspaceId !== authority.workspaceId) throw new DesktopApiConnectionRefusal('This connection belongs to another workspace.')
        const existing = await authority.get(id)
        if (!existing) throw new DesktopApiConnectionRefusal('Connection not found.')
        const connectionRevision = await store.revision(workspaceId, desktopApiConnectionIdSchema.parse(id))
        const usage = await authority.usage(id)
        const pendingRuns = await authority.pendingRuns(id)
        const preservedConnectionIds = (await authority.list()).filter(connection => connection.id !== id && allowed.has(connection.config.provider)).map(connection => desktopApiConnectionIdSchema.parse(connection.id))
        const idle = authority.removalAvailable?.() === true
        const canRemove = pendingRuns.length === 0 && !!authority.stopAndDrain && !!authority.withRemoval && idle
        return desktopApiRemovalPlanSchema.parse({
            version: 1,
            workspaceId,
            connectionId: id,
            connectionRevision,
            connection: await view(existing),
            usage,
            pendingRuns,
            preservedConnectionIds,
            canRemove,
            ...(!canRemove ? { reason: pendingRuns.length ? 'Stop the pending or unclassified runs in their conversations before removing this connection.'
                : !authority.stopAndDrain || !authority.withRemoval || !authority.removalAvailable ? 'Removal admission authority is unavailable.'
                    : 'Wait for workspace replies and background work to finish before removing this connection.' } : {}),
        })
    }

    async function remove(input: DesktopApiRemoveInput, signal?: AbortSignal): Promise<DesktopApiMutationResult> {
        if (input.workspaceId !== authority.workspaceId) throw new DesktopApiConnectionRefusal('This connection belongs to another workspace.')
        const nextRevision = revision()
        let plan: DesktopApiRemovalPlan
        const operation: MutationInput = {
            kind: 'remove', workspaceId: input.workspaceId, connectionId: input.connectionId, revision: nextRevision, requestId: input.requestId, input,
            apply: async () => {
                if (!authority.withRemoval || !authority.removalAvailable || !authority.stopAndDrain) throw new DesktopApiConnectionRefusal('Removal admission authority is unavailable.')
                if (!authority.removalAvailable()) throw new DesktopApiConnectionRefusal('Wait for workspace replies and background work to finish before removing this connection.')
                return authority.withRemoval(input.connectionId, async () => {
                    await current(input.connectionId, input.expectedRevision)
                    plan = await removalPlan(input.workspaceId, input.connectionId)
                    // The exclusive gate is held here, so its own availability flag is false.
                    if (plan.pendingRuns.length || !authority.stopAndDrain) throw new DesktopApiConnectionRefusal(plan.reason ?? 'Connection cannot be removed.')
                    operation.initial = { connection: null, removal: { released: plan.usage, preservedConnectionIds: plan.preservedConnectionIds } }
                    signal?.throwIfAborted()
                    await authority.stopAndDrain(input.connectionId)
                    plan = await removalPlan(input.workspaceId, input.connectionId)
                    if (plan.pendingRuns.length) throw new DesktopApiConnectionRefusal(plan.reason ?? 'Connection cannot be removed.')
                    const released = await authority.release(input.connectionId)
                    await authority.delete(input.connectionId)
                    await store.setRevision(input.workspaceId, input.connectionId, input.expectedRevision, nextRevision)
                    return result('remove', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: null, catalog: await catalog(), removal: { released, preservedConnectionIds: plan.preservedConnectionIds } })
                })
            },
            reconcile: async previous => {
                const nextRevision = previous.receipt.connectionRevision
                if (await authority.get(input.connectionId)) return null
                if (await store.revision(input.workspaceId, input.connectionId) !== nextRevision) return null
                const removal = previous.result?.removal ?? operation.initial?.removal
                if (!removal) return null
                return result('remove', 'saved', input.workspaceId, input.connectionId, nextRevision, input.requestId, input, { connection: null, catalog: await catalog(), removal }, true)
            },
        }
        return mutate(operation)
    }

    async function executionSnapshot(input: { connectionId: string; source: DesktopApiExecutionSnapshot['source']; runId: string; sessionId: string; requestId: string; model?: string; reasoningEffort?: string }): Promise<DesktopApiExecutionSnapshot> {
        const existing = await authority.get(input.connectionId)
        if (!existing) throw new DesktopApiConnectionRefusal('Connection not found.')
        const connectionRevision = await store.revision(authority.workspaceId, desktopApiConnectionIdSchema.parse(input.connectionId))
        const model = input.model ?? defaultModelOf(existing)
        if (![...existing.config.models, ...existing.config.extraModels].includes(model)) throw new DesktopApiConnectionRefusal('Choose a model offered by this connection.')
        return desktopApiExecutionSnapshotSchema.parse({
            version: 1,
            workspaceId: authority.workspaceId,
            connectionId: input.connectionId,
            connectionRevision,
            provider: existing.config.provider,
            model,
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            ...(existing.config.baseUrl !== undefined ? { baseUrl: existing.config.baseUrl } : {}),
            allowedModelIds: [...existing.config.models, ...existing.config.extraModels],
            source: input.source,
            runId: input.runId,
            requestId: input.requestId,
            sessionId: input.sessionId,
            capturedAt: now().toISOString(),
        })
    }

    async function credentialForSnapshot(raw: DesktopApiExecutionSnapshot): Promise<DesktopApiExecutionSnapshot & { secret: string }> {
        const snapshot = desktopApiExecutionSnapshotSchema.parse(raw)
        const existing = await authority.get(snapshot.connectionId)
        if (!existing || await store.revision(snapshot.workspaceId, snapshot.connectionId) !== snapshot.connectionRevision) throw new DesktopApiConnectionRefusal('This execution snapshot is no longer current. Start a new run.')
        if (!snapshot.allowedModelIds.includes(snapshot.model)) throw new DesktopApiConnectionRefusal('This execution snapshot names an unavailable model.')
        return { ...snapshot, secret: existing.env[CONNECTION_TOKEN_KEY[snapshot.provider]] }
    }

    return { list: catalog, create, rename, models, credential, select, removalPlan, remove, executionSnapshot, credentialForSnapshot }
}
