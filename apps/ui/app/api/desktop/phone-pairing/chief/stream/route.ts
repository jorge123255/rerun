import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneChiefChat, phoneChiefOptions, phoneChiefTurn } from '@/lib/desktop/server/phone-chief-binding'
import { phoneReplyStream } from '@/lib/desktop/server/phone-reply'
import { engineOf } from '@/lib/desktop/server/settings'
import { reconnectRun } from '@/lib/engine/client'

export const dynamic = 'force-dynamic'

// The text of the reply to the turn a phone started, as it is written: the same lines a coworker's
// reply is followed with, and nothing of the tools it calls.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const chat = phoneChiefChat(runtime, query.get('chatId'))
        const runId = z.uuid().safeParse(query.get('runId'))
        if (!runId.success) throw new DesktopHttpError(404, 'Not found')
        const run = await phoneChiefTurn(runtime, await desktopForeman(runtime), chat, runId.data)
        if (run?.status !== 'running') return new Response(null, { ...phoneChiefOptions, status: 204 })
        const reply = await reconnectRun(engineOf(runtime), 'foreman', runId.data)
        if (reply.status === 204) return new Response(null, { ...phoneChiefOptions, status: 204 })
        if (!reply.ok || !reply.body) throw new DesktopHttpError(502, 'This reply is unavailable.')
        return new Response(phoneReplyStream(reply.body, runId.data), { headers: { ...phoneChiefOptions.headers, 'content-type': 'application/x-ndjson' } })
    })
}
