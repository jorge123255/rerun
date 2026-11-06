import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopServiceAccounts } from '@/lib/desktop/server/services/accounts/binding'

export const dynamic = 'force-dynamic'

async function handle(request: Request, agentId: string): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const feature = await desktopServiceAccounts(runtime)
        return feature.handle(request, agentId)
    })
}

export async function GET(request: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
    const { agentId } = await context.params
    return handle(request, agentId)
}

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
    const { agentId } = await context.params
    return handle(request, agentId)
}
