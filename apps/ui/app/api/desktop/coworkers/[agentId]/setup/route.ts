import { desktopSetupPostSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { mutateDesktopSetup, readDesktopSetupView } from '@/lib/desktop/server/setup/service'

type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const view = await readDesktopSetupView(runtime, (await params).agentId)
        return Response.json(view, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopSetupPostSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Unknown setup request')
        const input = parsed.data
        const result = await mutateDesktopSetup(runtime, (await params).agentId, input)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
