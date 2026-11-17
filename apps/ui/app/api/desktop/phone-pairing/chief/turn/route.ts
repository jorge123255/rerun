import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneChiefChat, phoneChiefOptions, phoneChiefTurn } from '@/lib/desktop/server/phone-chief-binding'

export const dynamic = 'force-dynamic'

// How the turn a phone started stands.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const chat = phoneChiefChat(runtime, query.get('chatId'))
        const runId = z.uuid().safeParse(query.get('runId'))
        if (!runId.success) throw new DesktopHttpError(404, 'Not found')
        const run = await phoneChiefTurn(runtime, await desktopForeman(runtime), chat, runId.data)
        return Response.json({ status: run?.status ?? 'error' }, phoneChiefOptions)
    })
}
