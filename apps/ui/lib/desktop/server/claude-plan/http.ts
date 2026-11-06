import 'server-only'

import { desktopClaudePlanActionSchema, desktopClaudePlanSnapshotSchema } from '@rerun/contracts'
import { request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { desktopRoute } from '../http'
import { boundedText } from '../mcp/remote'
import { engineOf, readDesktopProviders } from '../settings'

/** The engine owns PKCE and the encrypted connection; this boundary only validates safe DTOs. */
export function desktopClaudePlanHttp(request: Request) {
    return desktopRoute(request, async runtime => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35_000)])
        let body: string | undefined
        if (request.method === 'POST') {
            const raw = await boundedText(new Response(request.body), signal, 20_000)
            const parsed = desktopClaudePlanActionSchema.safeParse(JSON.parse(raw))
            if (!parsed.success) throw new DesktopHttpError(400, 'This Claude sign-in request is invalid.')
            body = JSON.stringify(parsed.data)
        } else if (request.method !== 'GET') throw new DesktopHttpError(405, 'Method not allowed')
        try {
            const status = await engineRequest(engineOf(runtime), '/desktop/claude-login', { method: request.method, body, signal, cache: 'no-store' }, value => desktopClaudePlanSnapshotSchema.parse(value))
            return Response.json({ status, providers: await readDesktopProviders(runtime) }, { headers: { 'cache-control': 'no-store' } })
        } catch {
            throw new DesktopHttpError(409, 'Claude sign-in could not be confirmed. Check the saved state before trying again.')
        }
    })
}
