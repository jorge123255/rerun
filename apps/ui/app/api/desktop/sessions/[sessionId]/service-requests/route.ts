import { desktopServiceRequestMutationSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { assertCoworkerNotDeleting } from '@/lib/desktop/server/coworker-delete'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { describeDesktopServiceRequestCatalog, readDesktopServiceConnections, readDesktopServiceSource, sendDesktopServiceFollowUp } from '@/lib/desktop/server/service-requests/adapters'
import { ensureDesktopServiceSuggestionSchema } from '@/lib/desktop/server/service-requests/schema'
import { finishDesktopServiceRequest, progressDesktopServiceRequest, readDesktopServiceRequest } from '@/lib/desktop/server/service-requests/service'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { findDesktopAgent, findDesktopSession } from '@/lib/desktop/server/store'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

async function scopeOf(runtime: DesktopRuntime, sessionId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensureDesktopServiceSuggestionSchema(db)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    await assertCoworkerNotDeleting(db, session.agentId)
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { db, session, agent, scope: { agentId: agent.id, sessionId: session.id, enabled: agent.enabled } }
}

function ports(runtime: DesktopRuntime, bound: Awaited<ReturnType<typeof scopeOf>>, signal: AbortSignal) {
    return {
        source: () => readDesktopServiceSource(runtime, bound.agent, bound.session, signal),
        catalog: (slug: string) => describeDesktopServiceRequestCatalog(slug),
        installations: () => readDesktopServiceConnections(runtime, bound.agent.id, signal),
        send: (receipt: Parameters<typeof sendDesktopServiceFollowUp>[3], mode: 'send' | 'replay') => sendDesktopServiceFollowUp(runtime, bound.agent, bound.session, receipt, mode),
    }
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const bound = await scopeOf(runtime, (await params).sessionId)
        return Response.json(await readDesktopServiceRequest(bound.db, bound.scope, ports(runtime, bound, signal)), { headers: { 'cache-control': 'no-store' } })
    })
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const parsed = desktopServiceRequestMutationSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Save each app as pending, skip, or a current connection, then finish only those saved choices.')
        const bound = await scopeOf(runtime, (await params).sessionId)
        const boundPorts = ports(runtime, bound, signal)
        if (parsed.data.action === 'progress') return Response.json(await progressDesktopServiceRequest(bound.db, bound.scope, boundPorts, parsed.data), { headers: { 'cache-control': 'no-store' } })
        return finishDesktopServiceRequest(bound.db, bound.scope, boundPorts, parsed.data)
    })
}
