import 'server-only'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { abortable, boundedText } from '../mcp/remote'
import { privateFileCall, privateFilePublisher } from './publication'

// Route bundles share the same authority service and publisher, including calls whose observer
// stopped while an underlying filesystem operation was still settling.
const PUBLISHERS = Symbol.for('rerun.desktop.private-file.publishers.v1')
type Service = Awaited<ReturnType<typeof getDesktopRemoteMcpService>>
type Publisher = ReturnType<typeof privateFilePublisher>
const publishers = () => {
    const globals = globalThis as unknown as Record<symbol, WeakMap<Service, Publisher>>
    return globals[PUBLISHERS] ??= new WeakMap()
}

export async function handleDesktopPrivateFileTool(request: Request): Promise<Response> {
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const runtime = await abortable(authenticateDesktopEngineRequest(request), signal)
        const call = privateFileCall.parse(JSON.parse(await boundedText(new Response(request.body), signal, 2 * 1024 * 1024)))
        const service = await abortable(getDesktopRemoteMcpService(runtime), signal)
        const stop = AbortSignal.any([signal, service.shutdownSignal])
        let publish = publishers().get(service)
        if (!publish) {
            const db = await abortable(openDesktopDatabase(runtime.dataRoot), stop)
            publish = publishers().get(service)
            if (!publish) {
                publish = privateFilePublisher(db, async (identity, current) => ({
                    owner: await service.authorizeRun(identity, current, 'privateFileWrite'), runtime,
                }))
                publishers().set(service, publish)
            }
        }
        const result = await publish(call, stop)
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
        return Response.json({ status: 'refused', message: 'Private file publication unavailable; no save acknowledgement. Inspect Files before trying another call.' }, {
            status: error instanceof DesktopHttpError ? error.status : 400, headers: { 'Cache-Control': 'no-store' },
        })
    }
}
