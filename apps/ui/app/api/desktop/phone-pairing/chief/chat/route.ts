import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneChiefChat, phoneChiefIntake, phoneChiefOptions, readPhoneChiefChat } from '@/lib/desktop/server/phone-chief-binding'

export const dynamic = 'force-dynamic'

// One conversation with the Chief of Staff: its messages as text, the question it waits on, and
// the words of the cards only the Mac settles.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const chat = phoneChiefChat(runtime, new URL(request.url).searchParams.get('chatId'))
        const app = await desktopForeman(runtime)
        if (await phoneChiefIntake(runtime, app)) return Response.json({ state: 'intake' }, phoneChiefOptions)
        return Response.json({ state: 'ready', ...await readPhoneChiefChat(runtime, app, chat) }, phoneChiefOptions)
    })
}
