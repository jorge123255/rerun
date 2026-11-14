import { desktopCliUpdateActionSchema, desktopCliUpdatesSchema } from '@rerun/contracts'
import { request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }

// The version of each plan tool (Claude, Codex, Kimi, Grok, Devin) and whether its vendor has a newer one.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await engineRequest(engineOf(runtime), '/desktop/cli-updates', {
        method: 'GET', signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), cache: 'no-store',
    }, value => desktopCliUpdatesSchema.parse(value)), { headers }))
}

// Check the vendors now, start an update, or go back to the built-in copy. The engine does the
// download and every check on it; this route only carries the choice.
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const action = desktopCliUpdateActionSchema.safeParse(await request.json().catch(() => null))
        if (!action.success) throw new DesktopHttpError(400, 'Choose an update action.')
        return Response.json(await engineRequest(engineOf(runtime), '/desktop/cli-updates', {
            method: 'POST', body: JSON.stringify(action.data), headers: { 'content-type': 'application/json' },
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]), cache: 'no-store',
        }, value => desktopCliUpdatesSchema.parse(value)), { headers })
    })
}
