import { desktopScreenSetupActionSchema, desktopScreenSetupSchema } from '@rerun/contracts'
import { request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }

// What the coworker screen still needs on this Mac: Docker, a running Docker, or its image.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await engineRequest(engineOf(runtime), '/desktop/isolated-screen/setup', {
        method: 'GET', signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), cache: 'no-store',
    }, value => desktopScreenSetupSchema.parse(value)), { headers }))
}

// Start or stop the one-time build of the screen image. The engine does the build; this carries the click.
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const action = desktopScreenSetupActionSchema.safeParse(await request.json().catch(() => null))
        if (!action.success) throw new DesktopHttpError(400, 'Choose a screen setup action.')
        return Response.json(await engineRequest(engineOf(runtime), '/desktop/isolated-screen/setup', {
            method: 'POST', body: JSON.stringify(action.data), headers: { 'content-type': 'application/json' },
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), cache: 'no-store',
        }, value => desktopScreenSetupSchema.parse(value)), { headers })
    })
}
