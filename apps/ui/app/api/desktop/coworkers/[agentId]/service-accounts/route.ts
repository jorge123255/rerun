import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import type { AccountFeature } from '@/lib/desktop/server/services/accounts/feature'

export const dynamic = 'force-dynamic'

const UNWIRED = 'Service account routing is not wired to the desktop credential authority.'
let opener: ((runtime: DesktopRuntime) => Promise<AccountFeature>) | undefined

/** Root calls this where the desktop MCP binding is created. One registration. */
export function bindDesktopServiceAccounts(next: (runtime: DesktopRuntime) => Promise<AccountFeature>) {
    opener = next
}

async function handle(request: Request, agentId: string): Promise<Response> {
    return desktopRoute(request, async runtime => {
        if (!opener) return Response.json({ error: UNWIRED }, { status: 503, headers: { 'cache-control': 'no-store' } })
        const feature = await opener(runtime)
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
