import { foremanChatRefSchema } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForemanCallTargets } from '@/lib/desktop/server/coworker-calls/targets'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

const scope = foremanChatRefSchema.extend({ launchNonce: z.uuid() })
function handle(request: Request, patch: boolean) {
    return desktopRoute(request, async runtime => {
        const input = scope.safeParse(Object.fromEntries(new URL(request.url).searchParams))
        if (!input.success) throw new DesktopHttpError(400, 'Choose the current Foreman conversation.')
        const { launchNonce, ...chat } = input.data
        return Response.json(await desktopForemanCallTargets(runtime, chat, launchNonce,
            patch ? await readDesktopJson(request, 16_000) : undefined, request.signal), { headers: { 'cache-control': 'no-store' } })
    })
}

export const GET = (request: Request) => handle(request, false)
export const PATCH = (request: Request) => handle(request, true)
