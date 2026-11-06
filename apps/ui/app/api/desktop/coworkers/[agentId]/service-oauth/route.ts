import { handleDesktopServiceOAuth } from '@/lib/desktop/server/services/oauth/handler'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
    return handleDesktopServiceOAuth(request, (await context.params).agentId)
}
