import 'server-only'
import {
    desktopApiConnectionCatalogSchema, desktopApiRemovalPlanSchema, desktopApiMutationResultSchema,
    desktopApiMutationKindSchema, desktopApiConnectionIdSchema, desktopApiCreateInputSchema,
    desktopApiRenameInputSchema, desktopApiModelsInputSchema, desktopApiCredentialInputSchema,
    desktopApiSelectInputSchema, desktopApiRemoveInputSchema,
    type DesktopApiSelectInput,
} from '@rerun/contracts'
import type { z } from 'zod'
import { request as engineRequest } from '@/lib/engine/client'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { sendApiConnectionOperation, type ApiConnectionsApi, type ApiConnectionOperation, type ApiConnectionRoutes } from './client'

function allowedEnginePath(path: string, mutation: boolean): boolean {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#]/.test(path)
        || [...path].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) return false
    const url = new URL(path, 'http://desktop.invalid')
    if (url.origin !== 'http://desktop.invalid' || url.pathname !== path.split('?')[0]) return false
    if (mutation) return !url.search && /^\/desktop\/api-connections\/(?:create|rename|models|credential|select|remove)$/.test(url.pathname)
    const keys = [...url.searchParams.keys()]
    const workspace = url.searchParams.get('workspaceId') ?? ''
    if (!/^[1-9]\d*$/.test(workspace) || !Number.isSafeInteger(Number(workspace))) return false
    if (url.pathname === '/desktop/api-connections/catalog') return keys.length === 1 && keys[0] === 'workspaceId'
    return url.pathname === '/desktop/api-connections/removal' && keys.length === 2 && new Set(keys).size === 2
        && keys.includes('workspaceId') && keys.includes('connectionId') && desktopApiConnectionIdSchema.safeParse(url.searchParams.get('connectionId')).success
}

export function createApiConnectionsEngineProxy(runtime: DesktopRuntime, routes: ApiConnectionRoutes): ApiConnectionsApi {
    async function read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, input?: unknown): Promise<T> {
        if (!allowedEnginePath(path, input !== undefined)) throw new DesktopHttpError(503, 'The local connection service is unavailable.')
        try {
            return await engineRequest({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }, path, {
                method: input === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error',
                signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
                ...(input !== undefined && { body: JSON.stringify(input) }),
            }, body => schema.parse(body))
        } catch { throw new DesktopHttpError(502, 'Could not confirm the connection request. Retry the same request.') }
    }
    return {
        list: (workspaceId, signal) => read(routes.catalog(workspaceId), desktopApiConnectionCatalogSchema, signal),
        removalPlan: (workspaceId, id, signal) => read(routes.removalPlan(workspaceId, id), desktopApiRemovalPlanSchema, signal),
        create: (input, signal) => read(routes.mutation(input.workspaceId, 'create'), desktopApiMutationResultSchema, signal, desktopApiCreateInputSchema.parse(input)),
        rename: (input, signal) => read(routes.mutation(input.workspaceId, 'rename'), desktopApiMutationResultSchema, signal, desktopApiRenameInputSchema.parse(input)),
        models: (input, signal) => read(routes.mutation(input.workspaceId, 'models'), desktopApiMutationResultSchema, signal, desktopApiModelsInputSchema.parse(input)),
        credential: (input, signal) => read(routes.mutation(input.workspaceId, 'credential'), desktopApiMutationResultSchema, signal, desktopApiCredentialInputSchema.parse(input)),
        select: (input, signal) => read(routes.mutation(input.workspaceId, 'select'), desktopApiMutationResultSchema, signal, desktopApiSelectInputSchema.parse(input)),
        remove: (input, signal) => read(routes.mutation(input.workspaceId, 'remove'), desktopApiMutationResultSchema, signal, desktopApiRemoveInputSchema.parse(input)),
    }
}

function workspace(runtime: DesktopRuntime, expected: string) {
    if (String(runtime.workspaceId) !== expected) throw new DesktopHttpError(409, 'Workspace changed.')
}
async function stillCurrent(request: Request, before: DesktopRuntime) {
    const after = await authenticateDesktopRequest(request)
    if (after.workspaceId !== before.workspaceId || after.launchNonce !== before.launchNonce || after.buildId !== before.buildId || after.engine.origin !== before.engine.origin) throw new DesktopHttpError(409, 'Workspace changed. Reconcile the original connection request.')
}
function operation(kind: string, raw: unknown): ApiConnectionOperation {
    switch (desktopApiMutationKindSchema.parse(kind)) {
        case 'create': return { kind: 'create', input: desktopApiCreateInputSchema.parse(raw) }
        case 'rename': return { kind: 'rename', input: desktopApiRenameInputSchema.parse(raw) }
        case 'models': return { kind: 'models', input: desktopApiModelsInputSchema.parse(raw) }
        case 'credential': return { kind: 'credential', input: desktopApiCredentialInputSchema.parse(raw) }
        case 'select': return { kind: 'select', input: desktopApiSelectInputSchema.parse(raw) }
        case 'remove': return { kind: 'remove', input: desktopApiRemoveInputSchema.parse(raw) }
    }
}

/** Root mounts these authenticated handlers only after registering F's actual engine service. */
export function createApiConnectionsRouteHandlers(engineRoutes: ApiConnectionRoutes, options: {
    authorizeSelection?(runtime: DesktopRuntime, input: DesktopApiSelectInput, signal: AbortSignal): Promise<void>
} = {}) {
    return {
        catalog: (request: Request, expectedWorkspace: string) => desktopRoute(request, async runtime => {
            workspace(runtime, expectedWorkspace)
            const catalog = await createApiConnectionsEngineProxy(runtime, engineRoutes).list(runtime.workspaceId, request.signal)
            await stillCurrent(request, runtime)
            if (catalog.workspaceId !== runtime.workspaceId || catalog.connections.some(c => c.workspaceId !== runtime.workspaceId)) throw new DesktopHttpError(502, 'The connection catalog belongs to another workspace.')
            return Response.json(catalog)
        }),
        removalPlan: (request: Request, expectedWorkspace: string, id: string) => desktopRoute(request, async runtime => {
            workspace(runtime, expectedWorkspace); desktopApiConnectionIdSchema.parse(id)
            const plan = await createApiConnectionsEngineProxy(runtime, engineRoutes).removalPlan(runtime.workspaceId, id, request.signal)
            await stillCurrent(request, runtime)
            if (plan.workspaceId !== runtime.workspaceId || plan.connectionId !== id) throw new DesktopHttpError(502, 'The removal review belongs to another connection.')
            return Response.json(plan)
        }),
        mutation: (request: Request, expectedWorkspace: string, kind: string) => desktopRoute(request, async runtime => {
            workspace(runtime, expectedWorkspace)
            const pending = operation(kind, await readDesktopJson(request, 256 * 1024))
            if (pending.input.workspaceId !== runtime.workspaceId) throw new DesktopHttpError(409, 'Workspace changed.')
            if (pending.kind === 'select') {
                if (!options.authorizeSelection) throw new DesktopHttpError(503, 'The current model selection authority is unavailable.')
                await options.authorizeSelection(runtime, pending.input, request.signal)
            }
            await stillCurrent(request, runtime)
            const result = await sendApiConnectionOperation(createApiConnectionsEngineProxy(runtime, engineRoutes), pending, request.signal)
            await stillCurrent(request, runtime)
            if (result.receipt.requestId !== pending.input.requestId || result.receipt.workspaceId !== runtime.workspaceId || result.receipt.kind !== pending.kind || result.receipt.status !== result.status
                || pending.kind !== 'create' && result.receipt.connectionId !== pending.input.connectionId) throw new DesktopHttpError(502, 'The connection acknowledgement belongs to another request.')
            return Response.json(result)
        }),
    }
}
