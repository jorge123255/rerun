import { handleDesktopMcpOAuth } from '@/lib/desktop/server/mcp-binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return handleDesktopMcpOAuth(request, (await params).agentId)
}
