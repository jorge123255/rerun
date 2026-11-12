import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { createForemanConversation, listForemanConversations } from '@/lib/desktop/server/foreman/chat-store'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

const newConversation = z.strictObject({ workspaceId: z.string(), requestId: z.uuid(), prompt: z.string().trim().min(1).max(4000).optional() })
const headers = { 'cache-control': 'no-store' }

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        return Response.json({ conversations: await listForemanConversations(db, String(runtime.workspaceId)) }, { headers })
    })
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const input = newConversation.safeParse(await readDesktopJson(request, 32_768))
        if (!input.success) throw new DesktopHttpError(400, 'Invalid Chief of Staff conversation.')
        if (input.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Workspace not found.')
        assertDesktopWorkspaceAdmission(runtime)
        const db = await openDesktopDatabase(runtime.dataRoot)
        return Response.json({ chat: await createForemanConversation(db, runtime, input.data.requestId, input.data.prompt) }, { headers })
    })
}
