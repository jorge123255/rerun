import { desktopSubscriptionLoginAction, desktopSubscriptionLoginSnapshot } from '@rerun/contracts'
import { request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { boundedText } from '@/lib/desktop/server/mcp/remote'
import { engineOf } from '@/lib/desktop/server/settings'

function proxy(request: Request) {
    return desktopRoute(request, async runtime => {
        let timeout = 15_000
        let body: string | undefined
        if (request.method === 'POST') {
            const raw = await boundedText(new Response(request.body), AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]), 1024)
            let input: unknown
            try { input = JSON.parse(raw) }
            catch { throw new DesktopHttpError(400, 'Invalid subscription sign-in action.') }
            const parsed = desktopSubscriptionLoginAction.safeParse(input)
            if (!parsed.success) throw new DesktopHttpError(400, 'Invalid subscription sign-in action.')
            if (parsed.data.action === 'refresh-models') timeout = 185_000
            body = JSON.stringify(parsed.data)
        }
        const state = await engineRequest(engineOf(runtime), '/desktop/subscription-login', {
            method: request.method, body, signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]), cache: 'no-store',
        }, value => desktopSubscriptionLoginSnapshot.parse(value))
        return Response.json(state, { headers: { 'Cache-Control': 'no-store' } })
    })
}

export const GET = proxy
export const POST = proxy
