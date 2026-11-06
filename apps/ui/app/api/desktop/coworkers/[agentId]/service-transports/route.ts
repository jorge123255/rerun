import { handleDesktopServiceTransports } from '@/lib/desktop/server/services/transports/handler'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
    return handleDesktopServiceTransports(request, (await context.params).agentId)
}
