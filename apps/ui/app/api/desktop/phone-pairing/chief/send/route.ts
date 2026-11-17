import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { createForemanConversation, ensureForemanChat, ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneChiefAction, phoneChiefChatId, phoneChiefIntake, phoneChiefOptions } from '@/lib/desktop/server/phone-chief-binding'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'

// A message for the Chief of Staff: in a conversation the phone names, in a new task thread, or in
// General when it names neither. The ids are made by the pairing service, never by the phone.
const input = z.strictObject({
    runId: z.uuid(), text: z.string().max(20_000).refine(text => !!text.trim()),
    chatId: phoneChiefChatId.optional(), newChatRequestId: z.uuid().optional(),
}).refine(body => !(body.chatId && body.newChatRequestId))

// Sends through the Chief of Staff's own send path, with every check it makes: one message at a
// time, the receipt a retry of the same message is matched against, and the model the Mac chose
// for the conversation. A phone names no model, no instructions and no attachment.
export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const body = input.safeParse(await readDesktopJson(request, 128 * 1024).catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Write a message.')
        const { runId, text, chatId, newChatRequestId } = body.data
        const app = await desktopForeman(runtime), workspaceId = String(runtime.workspaceId)
        // The first-run company questions are answered on the Mac, and nothing is sent around them.
        if (await phoneChiefIntake(runtime, app)) throw new DesktopHttpError(409, 'Finish setting up the Chief of Staff on this Mac first.')
        return phoneChiefAction(async () => {
            const chat = chatId ? (await ownedForemanChat(app.db, { workspaceId, chatId })).chat
                : newChatRequestId ? await createForemanConversation(app.db, runtime, newChatRequestId)
                : (await ensureForemanChat(app.db, workspaceId)).chat
            await assertDesktopWorkspaceAdmission(runtime)
            const sent = await app.send(chat, runId, text.trim())
            if (sent.runId !== runId) throw new DesktopHttpError(502, 'Could not confirm this message.')
            return Response.json({ runId, chatId: chat.chatId }, phoneChiefOptions)
        })
    })
}
