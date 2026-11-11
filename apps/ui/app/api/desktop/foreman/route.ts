import { desktopQuestionAnswerSchema } from '@/lib/desktop/questions'
import { desktopForemanSavedUiSchema } from '@/lib/desktop/foreman-client/ui-schema'
import { ForemanRefusal } from '@/lib/desktop/server/foreman/authority'
import { z } from 'zod'
import { foremanBuildActionSchema, foremanChatRefSchema, foremanDecisionInputSchema, foremanModelRefSchema } from '@rerun/contracts'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { ownedForemanChat, withForemanChatWrite } from '@/lib/desktop/server/foreman/chat-store'
import { ForemanError } from '@/lib/desktop/server/foreman/runtime'
import { cancelCompanyBriefChat } from '@/lib/desktop/server/company-brief/client'
import { desktopForemanVoice } from '@/lib/desktop/server/foreman-voice/binding'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'
import { localStarterDecisionSchema } from '@/lib/desktop/server/foreman-starter/local-decision'
export const runtime = 'nodejs'
const inputSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('send'), chat: foremanChatRefSchema, requestId: z.uuid(), text: z.string().trim().min(1).max(20_000), modelChoice: foremanModelRefSchema.optional() }),
    z.strictObject({ action: z.literal('answer'), chat: foremanChatRefSchema, input: desktopQuestionAnswerSchema }),
    z.strictObject({ action: z.literal('starter'), chat: foremanChatRefSchema, input: localStarterDecisionSchema }),
    z.strictObject({ action: z.literal('stop'), chat: foremanChatRefSchema }),
    z.strictObject({ action: z.literal('decision'), input: foremanDecisionInputSchema }),
    z.strictObject({ action: z.literal('recover'), chat: foremanChatRefSchema, requestId: z.uuid() }),
    z.strictObject({ action: z.literal('build'), input: foremanBuildActionSchema }),
    z.strictObject({ action: z.literal('ui'), chat: foremanChatRefSchema, expectedRevision: z.number().int().nonnegative(), snapshot: desktopForemanSavedUiSchema }),
])
export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const app = await desktopForeman(runtime), state = await app.state()
        const row = (await app.db.execute({ sql: 'SELECT ui,ui_revision FROM desktop_foreman_chats WHERE chat_id=?', args: [state.chat.chatId] })).rows[0]!
        return Response.json({ ...state, ui: { snapshot: row.ui ? JSON.parse(String(row.ui)) : null, revision: Number(row.ui_revision) } }, { headers: { 'cache-control': 'no-store' } })
    })
}
export async function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await readDesktopJson(request, 128 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'This Foreman action was not understood.')
        const input = parsed.data, app = await desktopForeman(runtime)
        const chat = 'chat' in input ? input.chat : input.input.chat
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        await ownedForemanChat(app.db, chat)
        if (input.action !== 'ui' && input.action !== 'stop') await assertDesktopWorkspaceAdmission(runtime)
        try {
            if (input.action === 'send') return Response.json(await app.send(input.chat, input.requestId, input.text, input.modelChoice))
            if (input.action === 'answer') return Response.json(await app.answerQuestion(input.chat, input.input))
            if (input.action === 'starter') {
                return Response.json(await app.answerStarter(input.chat, input.input, AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])),
                    { headers: { 'cache-control': 'no-store' } })
            }
            if (input.action === 'stop') { await cancelCompanyBriefChat(runtime, input.chat); await (await desktopForemanVoice(runtime, app.voiceShutdownSignal)).cancelChat(input.chat); await app.stop(input.chat); return Response.json({ ok: true }) }
            if (input.action === 'decision') return Response.json(await app.core.decide(input.input))
            if (input.action === 'recover') return Response.json(await app.core.recoverDecision(input.chat, input.requestId))
            if (input.action === 'build') return Response.json(await app.core.buildAction(input.input))
            if (input.snapshot.workspaceId !== chat.workspaceId || input.snapshot.chatId !== chat.chatId) throw new DesktopHttpError(400, 'This saved view belongs to another conversation.')
            return withForemanChatWrite(app.db, async () => {
                const row = (await app.db.execute({ sql: 'SELECT ui_revision,ui FROM desktop_foreman_chats WHERE chat_id=?', args: [chat.chatId] })).rows[0]!
                const value = JSON.stringify(input.snapshot), revision = Number(row.ui_revision)
                if (row.ui === value) return Response.json({ revision })
                if (revision !== input.expectedRevision) throw new DesktopHttpError(409, 'The saved Foreman view changed. Reopen the panel before editing it.')
                await app.db.execute({ sql: 'UPDATE desktop_foreman_chats SET ui=?,ui_revision=ui_revision+1 WHERE chat_id=? AND ui_revision=?', args: [value, chat.chatId, revision] })
                return Response.json({ revision: revision + 1 })
            })
        } catch (error) {
            if (error instanceof ForemanRefusal) return Response.json({ error: error.message, code: error.failure }, { status: 409 })
            if (error instanceof ForemanError) return Response.json({ error: error.message, code: error.code }, { status: error.code === 'not_found' ? 404 : 409 })
            throw error
        }
    })
}
