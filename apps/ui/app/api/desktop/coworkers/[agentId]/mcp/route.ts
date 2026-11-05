import { handleDesktopMcpManagement } from '@/lib/desktop/server/mcp-binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }
async function handle(request: Request, { params }: Context) { return handleDesktopMcpManagement(request, (await params).agentId) }
export { handle as GET, handle as PUT, handle as POST, handle as DELETE }
