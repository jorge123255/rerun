import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopMcpSignInPorts } from '@/lib/desktop/server/mcp-sign-in/binding'
import { createDesktopMcpSignInApi } from '@/lib/desktop/server/mcp-sign-in/api'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
async function handle(request: Request, context: { params: Promise<{ sessionId: string }> }) {
    try {
        const runtime = await authenticateDesktopRequest(request), { sessionId } = await context.params
        const api = createDesktopMcpSignInApi(await desktopMcpSignInPorts(runtime, sessionId))
        return await api[request.method === 'GET' ? 'GET' : 'POST'](request, sessionId)
    } catch (error) { return Response.json({ error: 'MCP sign-in request unavailable or changed. Refresh this conversation.' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers: { 'cache-control': 'no-store' } }) }
}
export { handle as GET, handle as POST }
