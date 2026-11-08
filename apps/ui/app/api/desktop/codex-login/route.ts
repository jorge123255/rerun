import { desktopCodexAction, desktopCodexStatus } from '@rerun/contracts'
import { request as engineRequest } from '@/lib/engine/client'
import { desktopCodexStartSignal } from '@/lib/desktop/codex-login-budget'
import { desktopCodexLoginBody } from '@/lib/desktop/codex-login-response'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf, readDesktopProviders } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

function snapshot(runtime: Parameters<typeof engineOf>[0], init: RequestInit) {
    const engine = engineOf(runtime)
    return desktopCodexLoginBody(
        () => engineRequest(engine, '/desktop/codex-login', init, data => desktopCodexStatus.parse(data)),
        () => readDesktopProviders(runtime),
    )
}

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await snapshot(runtime, { method: 'GET', cache: 'no-store' })))
}
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopCodexAction.safeParse((await request.json().catch(() => null))?.action)
        if (!parsed.success) throw new DesktopHttpError(400, 'Unknown ChatGPT sign-in action.')
        const init: RequestInit = { method: 'POST', body: JSON.stringify({ action: parsed.data }) }
        if (parsed.data === 'start') init.signal = desktopCodexStartSignal()
        return Response.json(await snapshot(runtime, init))
    })
}
