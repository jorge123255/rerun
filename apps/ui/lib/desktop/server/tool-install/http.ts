import 'server-only'

import { desktopToolInstallActionSchema, type DesktopToolInstallPorts } from '@rerun/contracts'
import { authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { abortable, boundedText } from '../mcp/remote'
import type { DesktopRuntime } from '../runtime'
import { createDesktopToolInstallServer } from './service'

export function desktopToolInstallHttp(runtime: DesktopRuntime, ports: DesktopToolInstallPorts) {
    const server = createDesktopToolInstallServer(runtime, ports)
    return async (request: Request, sessionId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(305_000)])
        try {
            await abortable(authenticateDesktopRequest(request), signal)
            if (request.method === 'GET') {
                const operationId = new URL(request.url).searchParams.get('operationId')
                if (!operationId) throw new DesktopHttpError(400, 'Choose an installation to read.')
                return Response.json({ installation: await server.read(sessionId, operationId) }, { headers: { 'cache-control': 'no-store' } })
            }
            if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
            const input = desktopToolInstallActionSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 32_768)))
            const installation = input.operation === 'decide' ? await server.decide(sessionId, input, signal) : await server.inspect(sessionId, input, signal)
            return Response.json({ installation }, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            const status = error instanceof DesktopHttpError ? error.status : 400
            const message = error instanceof Error ? error.message.slice(0, 1_000) : 'Tool installation failed or its acknowledgement is uncertain.'
            return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } })
        }
    }
}
