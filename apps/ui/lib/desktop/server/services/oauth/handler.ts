import 'server-only'
import { authenticateDesktopRequest, DesktopHttpError } from '../../auth'
import { getDesktopRemoteMcpService } from '../../mcp-binding'
import { serviceOAuthApi } from './api'
export async function handleDesktopServiceOAuth(request: Request, owner: string): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request), service = await getDesktopRemoteMcpService(runtime)
        return serviceOAuthApi(service.serviceOAuth, async (request, owner) => { await service.services.current(owner, 'manage', undefined, request.signal) })(request, owner)
    } catch (error) {
        return Response.json({ error: 'OAuth unavailable or account changed. Refresh this account and retry.' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers: { 'cache-control': 'no-store' } })
    }
}
