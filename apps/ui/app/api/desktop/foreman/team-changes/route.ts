import { desktopTeamChangesSettleSchema, foremanChatRefSchema } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { readDesktopTeamChanges, settleDesktopTeamChanges } from '@/lib/desktop/server/foreman/team-changes'
import { readDesktopTeamGithubTarget } from '@/lib/desktop/server/foreman/team-changes-binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }

// The team changes the Chief of Staff proposed in a conversation. Reading shows the card; the
// POST only writes down what the person did with it. Each change itself is applied by the app
// window through the requests the person's own clicks make, never from here.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const chat = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!chat.success) throw new DesktopHttpError(400, 'Choose the Chief of Staff conversation.')
        if (chat.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const { db } = await desktopForeman(runtime)
        await ownedForemanChat(db, chat.data)
        const changes = await readDesktopTeamChanges(db, chat.data)
        const needsGithub = changes?.state === 'shown' && changes.changes.some(change => change.action === 'give_github')
        return Response.json({ changes, github: needsGithub ? await readDesktopTeamGithubTarget(runtime) : null }, { headers })
    })
}

const settle = z.strictObject({ chat: foremanChatRefSchema, settle: desktopTeamChangesSettleSchema })
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = settle.safeParse(await readDesktopJson(request, 64 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'This was not understood.')
        if (parsed.data.chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const { db } = await desktopForeman(runtime)
        await ownedForemanChat(db, parsed.data.chat)
        const changes = await settleDesktopTeamChanges(db, parsed.data.chat, parsed.data.settle)
        if (!changes) throw new DesktopHttpError(404, 'These changes are no longer here.')
        return Response.json({ changes, github: null }, { headers })
    })
}
