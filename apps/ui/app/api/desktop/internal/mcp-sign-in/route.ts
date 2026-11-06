import { handleDesktopMcpSignInBridge } from '@/lib/desktop/server/mcp-sign-in/binding'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
    try { return await handleDesktopMcpSignInBridge(request) }
    catch (error) { return Response.json({ error: 'MCP sign-in request unavailable.' }, { status: error instanceof DesktopHttpError ? error.status : 409 }) }
}
