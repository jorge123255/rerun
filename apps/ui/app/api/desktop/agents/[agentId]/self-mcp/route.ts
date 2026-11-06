import { handleDesktopSelfMcp } from '@/lib/desktop/server/self-mcp/api'
export const runtime = 'nodejs'
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return handleDesktopSelfMcp(request, (await params).agentId)
}
