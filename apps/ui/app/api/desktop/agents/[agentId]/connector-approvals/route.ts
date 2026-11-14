import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { forgetConnectorRuleOf, listConnectorRules } from '@/lib/desktop/server/connector-approvals/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Params = { params: Promise<{ agentId: string }> }

async function owner(db: Awaited<ReturnType<typeof openDesktopDatabase>>, params: Params['params']) {
    const agent = await findDesktopAgent(db, (await params).agentId)
    if (!agent) throw new DesktopHttpError(404, 'This coworker is not available.')
    return agent.id
}

// Every connector action this coworker may run without asking first, for its Tools settings.
export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        return Response.json({ rules: await listConnectorRules(db, await owner(db, params)) }, { headers: { 'cache-control': 'no-store' } })
    })
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = z.object({ ruleId: z.string().uuid() }).strict().safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose what to turn off.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        if (!await forgetConnectorRuleOf(db, await owner(db, params), parsed.data.ruleId)) throw new DesktopHttpError(409, 'This was already turned off.')
        return Response.json({ rules: await listConnectorRules(db, await owner(db, params)) })
    })
}
