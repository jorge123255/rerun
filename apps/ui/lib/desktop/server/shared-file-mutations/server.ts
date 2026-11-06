import 'server-only'
import type { Client } from '@libsql/client'
import { sharedMutationCallSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { abortable, boundedText } from '../mcp/remote'
import { SharedMutationRefusal, type SharedMutationAuthority } from './authority'
import { createSharedMutationPublisher } from './publisher'
import { createSharedReceiptSqliteStore } from './store'

const PUBLISHERS = Symbol.for('rerun.desktop.shared-file-mutations.publishers.v1')
type Publisher = ReturnType<typeof createSharedMutationPublisher>
const publishers = () => {
    const globals = globalThis as unknown as Record<symbol, WeakMap<Client, Publisher>>
    return globals[PUBLISHERS] ??= new WeakMap()
}

let authority: SharedMutationAuthority | null = null
export function bindSharedMutationAuthority(next: SharedMutationAuthority | null) { authority = next }

function refused(status: number, code: string, message: string) {
    return Response.json({ status: 'refused', code, message }, { status, headers: { 'cache-control': 'no-store' } })
}

export async function handleDesktopSharedFileMutation(request: Request): Promise<Response> {
    if (!authority) return refused(503, 'workspace_unbound', 'Shared file workspace authority is unbound.')
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const runtime = await abortable(authenticateDesktopEngineRequest(request), signal)
        const call = sharedMutationCallSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 2 * 1024 * 1024)))
        const db = await abortable(openDesktopDatabase(runtime.dataRoot), signal)
        let publish = publishers().get(db)
        if (!publish) {
            publish = createSharedMutationPublisher(createSharedReceiptSqliteStore(db), authority)
            publishers().set(db, publish)
        }
        const result = await publish(call, signal)
        const status = result.status === 'uncertain' ? 409 : result.status === 'refused' ? 409 : 200
        return Response.json(result, { status, headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        if (error instanceof SharedMutationRefusal) return refused(error.code === 'workspace_unbound' ? 503 : 409, error.code, error.message)
        if (error instanceof DesktopHttpError) return refused(error.status, 'grant', error.message)
        return refused(409, 'uncertain', 'Shared file publication did not answer. Nothing is written again on its own.')
    }
}
