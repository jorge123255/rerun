import { z } from 'zod'
import { foremanChatRefSchema, foremanAlternateViewSchema } from '@rerun/contracts'
import { bindForemanAlternates, listForemanAlternates, readForemanAlternate } from '@/lib/desktop/server/foreman-alternates/binding'
import { createForemanAlternateHandler } from '@/lib/desktop/server/foreman-alternates/handler'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'

export const runtime = 'nodejs'
export const POST = createForemanAlternateHandler(bindForemanAlternates)

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = foremanChatRefSchema.extend({ requestId: z.uuid().optional() })
            .safeParse(Object.fromEntries(new URL(request.url).searchParams))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid Chief of Staff retry request.')
        const { requestId, ...chat } = parsed.data
        const body = requestId
            ? foremanAlternateViewSchema.parse(await readForemanAlternate(runtime, chat, requestId, request.signal))
            : { items: await listForemanAlternates(runtime, chat) }
        return Response.json(body, { headers: { 'cache-control': 'no-store' } })
    })
}
