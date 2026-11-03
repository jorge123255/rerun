import { desktopCodexAction, desktopCodexStatus } from '@rerun/contracts'
import { request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf, readDesktopProviders } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const status = await engineRequest(engineOf(runtime), '/desktop/codex-login', { method: 'GET', cache: 'no-store' }, d => desktopCodexStatus.parse(d))
        return Response.json({ status, providers: await readDesktopProviders(runtime) })
    })
}
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopCodexAction.safeParse((await request.json().catch(() => null))?.action)
        if (!parsed.success) throw new DesktopHttpError(400, 'Unknown ChatGPT sign-in action.')
        const status = await engineRequest(engineOf(runtime), '/desktop/codex-login', { method: 'POST', body: JSON.stringify({ action: parsed.data }) }, d => desktopCodexStatus.parse(d))
        return Response.json({ status, providers: await readDesktopProviders(runtime) })
    })
}
