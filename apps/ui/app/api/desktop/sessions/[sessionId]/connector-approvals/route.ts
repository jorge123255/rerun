import { desktopConnectorApprovalActionSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { decideConnectorApproval, forgetConnectorRule, readConnectorApprovals } from '@/lib/desktop/server/connector-approvals/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Params = { params: Promise<{ sessionId: string }> }
const SESSION = /^[\w.:-]{1,200}$/

async function session(params: Params['params']) {
    const { sessionId } = await params
    if (!SESSION.test(sessionId)) throw new DesktopHttpError(400, 'This conversation is not available.')
    return sessionId
}

// The connector actions waiting for the person's answer in this conversation, and the standing
// answers that reach it.
export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(
        await readConnectorApprovals(await openDesktopDatabase(runtime.dataRoot), await session(params)), { headers: { 'cache-control': 'no-store' } }))
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopConnectorApprovalActionSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose an answer for this action.')
        const db = await openDesktopDatabase(runtime.dataRoot), sessionId = await session(params)
        if (parsed.data.action === 'forget') {
            if (!await forgetConnectorRule(db, sessionId, parsed.data.ruleId)) throw new DesktopHttpError(409, 'This was already turned off.')
            return Response.json({ ok: true })
        }
        const result = await decideConnectorApproval(db, sessionId, parsed.data.id, parsed.data.decision)
        if (!result) throw new DesktopHttpError(409, 'This action was already answered.')
        return Response.json(result)
    })
}
