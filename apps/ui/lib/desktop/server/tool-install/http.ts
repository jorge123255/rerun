import 'server-only'

import { desktopToolInstallAttention, desktopToolInstallActionSchema, type DesktopToolInstallPorts } from '@rerun/contracts'
import { desktopToolInstallReferenceOf } from '@/lib/desktop/tool-install-reference'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { abortable, boundedText } from '../mcp/remote'
import type { DesktopRuntime } from '../runtime'
import { createDesktopToolInstallServer } from './service'

export function desktopToolInstallHttp(runtime: DesktopRuntime, ports: DesktopToolInstallPorts) {
    const server = createDesktopToolInstallServer(runtime, ports)
    return async (request: Request, sessionId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(305_000)])
        try {
            const authenticated = await abortable(authenticateDesktopRequest(request), signal)
            if (JSON.stringify(authenticated) !== JSON.stringify(runtime)) throw new DesktopHttpError(409, 'Installation runtime changed')
            if (request.method === 'GET') {
                const query = new URL(request.url).searchParams
                if (query.get('pending') === '1' && [...query.keys()].length === 1) {
                    const rows = (await server.history(sessionId)).filter(row => desktopToolInstallAttention(row))
                    signal.throwIfAborted()
                    return Response.json({ installations: rows.slice(0, 24).map(desktopToolInstallReferenceOf), more: rows.length > 24 }, { headers: { 'cache-control': 'no-store' } })
                }
                const operationId = query.get('operationId')
                if (!operationId) throw new DesktopHttpError(400, 'Choose an installation to read.')
                return Response.json({ installation: await server.read(sessionId, operationId) }, { headers: { 'cache-control': 'no-store' } })
            }
            if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
            const input = desktopToolInstallActionSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 32_768)))
            const installation = input.operation === 'decide' ? await server.decide(sessionId, input, signal) : await server.inspect(sessionId, input, signal)
            return Response.json({ installation }, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            const status = error instanceof DesktopHttpError ? error.status : 400
            const message = error instanceof DesktopHttpError ? error.message : 'Tool installation changed or its result is uncertain. Refresh to see its saved state.'
            return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } })
        }
    }
}
