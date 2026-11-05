import { handleDesktopLocalMcp } from '@/lib/desktop/server/mcp-binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
async function handle(request: Request, context: { params: Promise<{ agentId: string }> }) { return handleDesktopLocalMcp(request, (await context.params).agentId) }
export { handle as GET, handle as POST, handle as PUT, handle as DELETE }
