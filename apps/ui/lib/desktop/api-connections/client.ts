import {
    desktopApiConnectionCatalogSchema, desktopApiRemovalPlanSchema, desktopApiMutationResultSchema,
    desktopApiCreateInputSchema, desktopApiRenameInputSchema, desktopApiModelsInputSchema,
    desktopApiCredentialInputSchema, desktopApiSelectInputSchema, desktopApiRemoveInputSchema,
    type DesktopApiConnectionCatalog, type DesktopApiRemovalPlan, type DesktopApiMutationResult,
    type DesktopApiCreateInput, type DesktopApiRenameInput, type DesktopApiModelsInput,
    type DesktopApiCredentialInput, type DesktopApiSelectInput, type DesktopApiRemoveInput,
    type DesktopApiMutationKind, type DesktopWorkspaceId,
} from '@rerun/contracts'
import type { z } from 'zod'

export type ApiConnectionsApi = {
    list(workspaceId: DesktopWorkspaceId, signal?: AbortSignal): Promise<DesktopApiConnectionCatalog>
    removalPlan(workspaceId: DesktopWorkspaceId, connectionId: string, signal?: AbortSignal): Promise<DesktopApiRemovalPlan>
    create(input: DesktopApiCreateInput, signal?: AbortSignal): Promise<DesktopApiMutationResult>
    rename(input: DesktopApiRenameInput, signal?: AbortSignal): Promise<DesktopApiMutationResult>
    models(input: DesktopApiModelsInput, signal?: AbortSignal): Promise<DesktopApiMutationResult>
    credential(input: DesktopApiCredentialInput, signal?: AbortSignal): Promise<DesktopApiMutationResult>
    select(input: DesktopApiSelectInput, signal?: AbortSignal): Promise<DesktopApiMutationResult>
    remove(input: DesktopApiRemoveInput, signal?: AbortSignal): Promise<DesktopApiMutationResult>
}
export type ApiConnectionOperation =
    | { kind: 'create'; input: DesktopApiCreateInput }
    | { kind: 'rename'; input: DesktopApiRenameInput }
    | { kind: 'models'; input: DesktopApiModelsInput }
    | { kind: 'credential'; input: DesktopApiCredentialInput }
    | { kind: 'select'; input: DesktopApiSelectInput }
    | { kind: 'remove'; input: DesktopApiRemoveInput }
export type ApiConnectionRoutes = {
    catalog(workspaceId: DesktopWorkspaceId): string
    removalPlan(workspaceId: DesktopWorkspaceId, connectionId: string): string
    mutation(workspaceId: DesktopWorkspaceId, kind: DesktopApiMutationKind): string
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 20_000
export function createApiConnectionsClient(routes: ApiConnectionRoutes, transport: typeof fetch = fetch): ApiConnectionsApi {
    async function request<T>(path: string, schema: z.ZodType<T>, input?: unknown, parent?: AbortSignal): Promise<T> {
        const url = new URL(path, window.location.origin)
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/desktop/') || url.username || url.password || url.hash || url.search) throw Error('The local connection route is unavailable.')
        const controller = new AbortController(), abort = () => controller.abort()
        parent?.addEventListener('abort', abort, { once: true })
        const timeout = setTimeout(abort, TIMEOUT_MS)
        try {
            if (parent?.aborted) controller.abort()
            controller.signal.throwIfAborted()
            const response = await transport(url.pathname, {
                method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
                signal: controller.signal,
                ...(input !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
            })
            if (!response.ok || !response.body) throw Error('Could not confirm the connection request. Retry the same request.')
            const reader = response.body.getReader(), chunks: Uint8Array[] = []
            let bytes = 0
            try {
                while (true) {
                    controller.signal.throwIfAborted()
                    const next = await reader.read()
                    if (next.done) break
                    bytes += next.value.byteLength
                    if (bytes > MAX_RESPONSE_BYTES) throw Error('The local connection response is too large.')
                    chunks.push(next.value)
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
            controller.signal.throwIfAborted()
            const body = new Uint8Array(bytes); let offset = 0
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
            const parsed = schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
            if (!parsed.success) throw Error('The local connection response is unavailable.')
            return parsed.data
        } catch {
            // Never echo a secret-bearing body, URL, server exception or validation payload.
            throw Error('Could not confirm the connection request. Retry the same request.')
        } finally { clearTimeout(timeout); parent?.removeEventListener('abort', abort) }
    }
    const mutate = async <T extends { workspaceId: number; requestId: string }>(kind: DesktopApiMutationKind, schema: z.ZodType<T>, raw: T, signal?: AbortSignal) => {
        const parsed = schema.safeParse(raw)
        if (!parsed.success) throw Error('Check the connection fields before saving.')
        const result = await request(routes.mutation(raw.workspaceId, kind), desktopApiMutationResultSchema, parsed.data, signal)
        if (result.receipt.workspaceId !== raw.workspaceId || result.receipt.requestId !== raw.requestId || result.receipt.kind !== kind || result.receipt.status !== result.status
            || kind !== 'create' && result.receipt.connectionId !== (raw as T & { connectionId: string }).connectionId
            || result.connection && result.connection.workspaceId !== raw.workspaceId
            || result.catalog && result.catalog.workspaceId !== raw.workspaceId) throw Error('The connection acknowledgement belongs to another request.')
        return result
    }
    return {
        async list(workspaceId, signal) {
            const catalog = await request(routes.catalog(workspaceId), desktopApiConnectionCatalogSchema, undefined, signal)
            if (catalog.workspaceId !== workspaceId || catalog.connections.some(c => c.workspaceId !== workspaceId)) throw Error('The catalog belongs to another workspace.')
            return catalog
        },
        async removalPlan(workspaceId, connectionId, signal) {
            const plan = await request(routes.removalPlan(workspaceId, connectionId), desktopApiRemovalPlanSchema, undefined, signal)
            if (plan.workspaceId !== workspaceId || plan.connectionId !== connectionId || plan.connection.workspaceId !== workspaceId || plan.connection.connectionId !== connectionId || plan.connection.revision !== plan.connectionRevision
                || plan.pendingRuns.some(run => run.connectionId !== connectionId) || plan.preservedConnectionIds.includes(connectionId)) throw Error('The removal review belongs to another connection.')
            return plan
        },
        create: (input, signal) => mutate('create', desktopApiCreateInputSchema, input, signal),
        rename: (input, signal) => mutate('rename', desktopApiRenameInputSchema, input, signal),
        models: (input, signal) => mutate('models', desktopApiModelsInputSchema, input, signal),
        credential: (input, signal) => mutate('credential', desktopApiCredentialInputSchema, input, signal),
        select: (input, signal) => mutate('select', desktopApiSelectInputSchema, input, signal),
        remove: (input, signal) => mutate('remove', desktopApiRemoveInputSchema, input, signal),
    }
}

export function sendApiConnectionOperation(api: ApiConnectionsApi, operation: ApiConnectionOperation, signal: AbortSignal) {
    switch (operation.kind) {
        case 'create': return api.create(operation.input, signal)
        case 'rename': return api.rename(operation.input, signal)
        case 'models': return api.models(operation.input, signal)
        case 'credential': return api.credential(operation.input, signal)
        case 'select': return api.select(operation.input, signal)
        case 'remove': return api.remove(operation.input, signal)
    }
}
