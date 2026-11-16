import { foremanChatRefSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { readDesktopGithubTeamAccess } from '@/lib/desktop/server/github-projects/access'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

// Whether the coworkers built for a conversation's GitHub projects can reach GitHub. Reading only.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const chat = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!chat.success) throw new DesktopHttpError(400, 'Choose the Chief of Staff conversation.')
        if (chat.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        await ownedForemanChat((await desktopForeman(runtime)).db, chat.data)
        return Response.json(await readDesktopGithubTeamAccess(runtime, chat.data), { headers: { 'cache-control': 'no-store' } })
    })
}
