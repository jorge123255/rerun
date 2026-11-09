import { z } from 'zod'
import { readDesktopGettingStarted, setDesktopGettingStartedDismissed } from '@/lib/desktop/server/getting-started'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ action: z.enum(['dismiss', 'reopen']) }).strict()

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopGettingStarted(runtime, request.signal), { headers: { 'cache-control': 'no-store' } }))
}

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = bodySchema.safeParse(await readDesktopJson(request, 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'Getting started action is not dismiss or reopen')
        const snapshot = await setDesktopGettingStartedDismissed(runtime, parsed.data.action === 'dismiss')
        return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } })
    })
}
