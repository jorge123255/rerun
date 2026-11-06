import 'server-only'
import type { Client } from '@libsql/client'
import { sharedMutationCallSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { abortable, boundedText } from '../mcp/remote'
import { SharedMutationRefusal, type SharedMutationAuthority } from './authority'
import { createSharedMutationPublisher } from './publisher'
import { createSharedReceiptSqliteStore } from './store'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { createDesktopSharedMutationAuthority } from './binding'

const PUBLISHERS = Symbol.for('rerun.desktop.shared-file-mutations.publishers.v2')
type Publisher = ReturnType<typeof createSharedMutationPublisher>
type Service = Awaited<ReturnType<typeof getDesktopRemoteMcpService>>
const publishers = () => {
    const globals = globalThis as unknown as Record<symbol, WeakMap<Service, { db: Client; publisher: Publisher }>>
    return globals[PUBLISHERS] ??= new WeakMap()
}

/** @deprecated Global authority injection is refused; bind the validated runtime/service instead. */
export function bindSharedMutationAuthority(_next: SharedMutationAuthority | null): never { throw new DesktopHttpError(503,'Shared-file authority must be scoped to the validated runtime.') }

function refused(status: number, code: string, message: string) {
    return Response.json({ status: 'refused', code, message }, { status, headers: { 'cache-control': 'no-store' } })
}

export async function handleDesktopSharedFileMutation(request: Request): Promise<Response> {
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const runtime = await abortable(authenticateDesktopEngineRequest(request), signal)
        const call = sharedMutationCallSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 2 * 1024 * 1024)))
        if (call.workspaceId !== runtime.workspaceId) throw new SharedMutationRefusal('stale_workspace', 'That workspace is not open.')
        const service = await abortable(getDesktopRemoteMcpService(runtime), signal)
        const stop = AbortSignal.any([signal, service.shutdownSignal])
        const db = await abortable(openDesktopDatabase(runtime.dataRoot), signal)
        let cached = publishers().get(service)
        if (!cached || cached.db !== db) {
            cached = { db, publisher: createSharedMutationPublisher(createSharedReceiptSqliteStore(db), createDesktopSharedMutationAuthority(runtime, service)) }
            publishers().set(service, cached)
        }
        const result = await cached.publisher(call, stop)
        const status = result.status === 'uncertain' ? 409 : result.status === 'refused' ? 409 : 200
        return Response.json(result, { status, headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        if (error instanceof SharedMutationRefusal) return refused(error.code === 'workspace_unbound' ? 503 : 409, error.code, error.message)
        if (error instanceof DesktopHttpError) return refused(error.status, 'grant', error.message)
        return refused(409, 'uncertain', 'Shared file publication did not answer. Nothing is written again on its own.')
    }
}
