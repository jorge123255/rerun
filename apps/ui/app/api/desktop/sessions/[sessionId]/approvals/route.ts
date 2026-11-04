import { desktopApprovalAnswerSchema } from '@/lib/desktop/approvals'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { answerDesktopApproval, readDesktopApproval } from '@/lib/desktop/server/approvals'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopApproval(runtime, (await params).sessionId), { headers: { 'cache-control': 'no-store' } }))
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopApprovalAnswerSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Approve or decline each action. Only declined actions can include a reason, with at most 20,000 characters in total.')
        return answerDesktopApproval(runtime, (await params).sessionId, parsed.data)
    })
}
