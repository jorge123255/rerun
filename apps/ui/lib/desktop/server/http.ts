import 'server-only'
import { authenticateDesktopRequest, DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'

export async function desktopRoute(request: Request, handler: (runtime: DesktopRuntime) => Promise<Response>,
    authenticate = authenticateDesktopRequest): Promise<Response> {
    try {
        return await handler(await authenticate(request))
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ error: error.message, code: error.code }, { status: error.status })
        return Response.json({ error: 'Desktop request failed' }, { status: 500 })
    }
}
