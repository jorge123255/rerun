import 'server-only'
import { desktopMcpSecretReferenceSaveSchema } from '@rerun/contracts'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { getDesktopRemoteMcpService, watchDesktopMcpOwner } from '../mcp-binding'
import { boundedText } from '../mcp/remote'

export async function handleDesktopMcpSecretReferences(request: Request, agentId: string) {
    try {
        const runtime = await authenticateDesktopRequest(request), signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)])
        const check = watchDesktopMcpOwner(runtime, agentId), service = await getDesktopRemoteMcpService(runtime)
        const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
        if (request.method === 'GET') {
            const query = new URL(request.url).searchParams, saveId = query.get('saveId')
            const permission = await service.access(agentId)
            check(); signal.throwIfAborted()
            if (!permission.enabled) throw new DesktopHttpError(409, 'This coworker is disabled.')
            if (saveId) {
                const result = await service.references.records.receipt(agentId, saveId)
                check(); signal.throwIfAborted()
                return result ? json(result) : json({ status: 'absent', saveId }, 404)
            }
            const snapshot = await service.references.snapshot(agentId, query.get('serverName') ?? '', signal)
            check(); return json(snapshot)
        }
        if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
        const body = JSON.parse(await boundedText(new Response(request.body), signal, 40000))
        const reconcile = body?.operation === 'reconcile'
        const input = desktopMcpSecretReferenceSaveSchema.parse(reconcile ? body.change : body)
        if (input.agentId !== agentId) throw new DesktopHttpError(409, 'These settings belong to another coworker.')
        check(); signal.throwIfAborted()
        const result = await (reconcile ? service.references.reconcile(input, signal) : service.references.save(input, signal))
        return json(result, result.status === 'conflict' ? 409 : result.status === 'not-saved' ? 400 : 200)
    } catch (error) {
        return Response.json({ error: error instanceof DesktopHttpError ? error.message : 'MCP credential settings are unavailable. Reload this server.' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers: { 'cache-control': 'no-store' } })
    }
}
