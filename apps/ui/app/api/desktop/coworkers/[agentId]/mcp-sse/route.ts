import { handleDesktopSse } from '@/lib/desktop/server/mcp-sse/api'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return handleDesktopSse(request, (await params).agentId)
}
