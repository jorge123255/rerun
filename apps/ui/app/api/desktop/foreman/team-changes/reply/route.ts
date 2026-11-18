import { desktopTeamChangeSchema, desktopTeamChangesSchema, foremanChatRefSchema } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { applySavedChiefSetupReply } from '@/lib/desktop/server/foreman/reviewed-setup-reply'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const dynamic = 'force-dynamic'
const selection = z.strictObject({ chat: foremanChatRefSchema, cardId: desktopTeamChangesSchema.shape.id, lineKey: desktopTeamChangeSchema.shape.key })

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const input = selection.safeParse(await readDesktopJson(request, 4096))
        if (!input.success) throw new DesktopHttpError(400, 'Choose a setup reply on the current proposal.')
        const { chat, cardId, lineKey } = input.data
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const { db } = await desktopForeman(runtime)
        await applySavedChiefSetupReply(runtime, db, chat, cardId, lineKey, request.signal)
        return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
    })
}
