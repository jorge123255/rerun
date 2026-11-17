import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { listForemanConversations } from '@/lib/desktop/server/foreman/chat-store'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneChiefConversations } from '@/lib/desktop/server/phone-chief'
import { phoneChiefIntake, phoneChiefOptions } from '@/lib/desktop/server/phone-chief-binding'

export const dynamic = 'force-dynamic'

// The Chief of Staff, for the pairing service to hand to an approved phone: General and the task
// threads someone wrote in. While it still asks its first-run company questions, which are answered
// on the Mac, a phone is told only that.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const app = await desktopForeman(runtime)
        if (await phoneChiefIntake(runtime, app)) return Response.json({ state: 'intake', conversations: [] }, phoneChiefOptions)
        return Response.json({ state: 'ready', conversations: phoneChiefConversations(await listForemanConversations(app.db, String(runtime.workspaceId))) }, phoneChiefOptions)
    })
}
