import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneChiefAction, phoneChiefChat, phoneChiefOptions, phoneChiefTurn } from '@/lib/desktop/server/phone-chief-binding'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const dynamic = 'force-dynamic'

const input = z.strictObject({ chatId: z.string(), runId: z.uuid() })

// Stops the reply to the turn a phone started, through the Chief of Staff's own stop. A reply that
// is not that turn's is left alone.
export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const body = input.safeParse(await readDesktopJson(request, 4096).catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Name the reply to stop.')
        const chat = phoneChiefChat(runtime, body.data.chatId)
        const app = await desktopForeman(runtime)
        const run = await phoneChiefTurn(runtime, app, chat, body.data.runId)
        return phoneChiefAction(async () => {
            if (run?.status === 'running' && (await app.core.readView(chat)).live?.runId === body.data.runId) await app.stop(chat)
            // A stop can race a normal completion. The turn's status says how it ended.
            return Response.json({ runId: body.data.runId }, phoneChiefOptions)
        })
    })
}
