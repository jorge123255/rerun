import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { foremanTurn, ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { readPendingForemanRequests } from '@/lib/desktop/server/foreman/question'
import { desktopRoute } from '@/lib/desktop/server/http'
import { phoneChiefAction, phoneChiefChatId, phoneChiefOptions } from '@/lib/desktop/server/phone-chief-binding'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'

// The answer to the question a conversation with the Chief of Staff waits on. The phone names the
// card it was shown, never the saved question: the Mac finds that itself.
const input = z.strictObject({
    chatId: phoneChiefChatId, runId: z.uuid(), toolCallId: z.string().min(1).max(256),
    answers: z.array(z.array(z.string().max(4000)).max(100)).min(1).max(32).optional(),
})
const gone = () => new DesktopHttpError(409, 'This question is no longer waiting for an answer.')

// Recorded through the Chief of Staff's own answer path, the one its question card on the Mac uses.
export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const body = input.safeParse(await readDesktopJson(request, 128 * 1024).catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Answer the question.')
        const { chatId, runId, toolCallId, answers } = body.data
        const app = await desktopForeman(runtime)
        const owner = await ownedForemanChat(app.db, { workspaceId: String(runtime.workspaceId), chatId })
        await assertDesktopWorkspaceAdmission(runtime)
        return phoneChiefAction(async () => {
            const { question } = await readPendingForemanRequests(runtime, owner)
            if (!question) {
                // Sent twice: the first one was taken, and its turn says so.
                const taken = await foremanTurn(app.db, runId)
                if (!taken?.body.answerIntent || taken.body.binding.chatId !== chatId) throw gone()
                return Response.json({ runId }, phoneChiefOptions)
            }
            if (question.view.toolCallId !== toolCallId || (answers && answers.length !== question.view.questions.length)) throw gone()
            const sent = await app.answerQuestion(owner.chat, answers
                ? { action: 'answer', questionId: question.view.id, requestId: runId, answers }
                : { action: 'cancel', questionId: question.view.id, requestId: runId })
            if (sent.runId !== runId) throw new DesktopHttpError(502, 'Could not confirm this answer.')
            return Response.json({ runId }, phoneChiefOptions)
        })
    })
}
