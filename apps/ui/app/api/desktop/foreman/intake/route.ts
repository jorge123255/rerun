import { z } from 'zod'
import { desktopForemanIntakeCompleteInputSchema, desktopForemanIntakeSaveInputSchema, foremanChatRefSchema } from '@rerun/contracts'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { createDesktopForemanIntakeBinding } from '@/lib/desktop/server/foreman/intake'
import { DesktopForemanIntakeConflictError, DesktopForemanIntakeRefusal } from '@/lib/desktop/server/foreman-intake/store'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const runtime = 'nodejs'
const inputSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('save'), input: desktopForemanIntakeSaveInputSchema }),
    z.strictObject({ action: z.literal('complete'), input: desktopForemanIntakeCompleteInputSchema }),
    z.strictObject({ action: z.literal('lookup'), chat: foremanChatRefSchema, requestId: z.uuid() }),
])

export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const parsed = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the Foreman conversation for these company details.')
        if (parsed.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const app = await desktopForeman(runtime)
        await ownedForemanChat(app.db, parsed.data)
        try {
            return Response.json(await createDesktopForemanIntakeBinding(runtime, app).read(parsed.data), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof DesktopForemanIntakeRefusal) throw new DesktopHttpError(error.status, error.message)
            throw error
        }
    })
}

export async function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await readDesktopJson(request, 32 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'These company details were not understood.')
        const input = parsed.data, chat = input.action === 'lookup' ? input.chat : input.input.chat
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const app = await desktopForeman(runtime)
        await ownedForemanChat(app.db, chat)
        const service = createDesktopForemanIntakeBinding(runtime, app)
        try {
            if (input.action === 'lookup') return Response.json({ completion: await service.lookupCompletion(chat, input.requestId) })
            if (input.action === 'save') {
                if (input.input.knownFirstName !== null || input.input.decidedIndustry !== null) throw new DesktopHttpError(400, 'Use your own company answers; automatic profile hints are unavailable on this workspace.')
                return Response.json(await service.save(input.input))
            }
            assertDesktopWorkspaceAdmission(runtime)
            return Response.json(await service.complete(input.input))
        } catch (error) {
            if (error instanceof DesktopForemanIntakeConflictError) return Response.json({ error: error.message, view: error.view }, { status: 409 })
            if (error instanceof DesktopForemanIntakeRefusal) return Response.json({ error: error.message }, { status: error.status })
            throw error
        }
    })
}
