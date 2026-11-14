import { desktopProviderUsageSchema } from '@rerun/contracts'
import { request as engineRequest } from '@/lib/engine/client'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

// What this Mac ran on each provider over the last day and week, for the header's providers list.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const usage = await engineRequest(engineOf(runtime), '/desktop/provider-usage', {
            method: 'GET', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]), cache: 'no-store',
        }, value => desktopProviderUsageSchema.parse(value))
        return Response.json(usage, { headers: { 'Cache-Control': 'no-store' } })
    })
}
