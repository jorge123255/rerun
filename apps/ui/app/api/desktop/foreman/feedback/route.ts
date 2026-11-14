import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { clearDesktopForemanFeedback, desktopForemanFeedbackRateSchema, desktopForemanFeedbackScopeSchema, listDesktopForemanFeedback, rateDesktopForemanFeedback } from '@/lib/desktop/server/foreman-feedback'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { z } from 'zod'

export const dynamic = 'force-dynamic'
const noStore = { 'cache-control': 'no-store' }

function scopeOf(url: URL) {
    const parsed = desktopForemanFeedbackScopeSchema.safeParse({
        workspaceId: url.searchParams.get('workspaceId'),
        chatId: url.searchParams.get('chatId'),
    })
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid feedback')
    return parsed.data
}

function savedAssistantIds(messages: readonly { id: string; role: string; parts: readonly unknown[] }[]): Set<string> {
    const ids = new Set<string>()
    for (const message of messages) {
        if (message.role !== 'assistant') continue
        const text = message.parts.map(part => part && typeof part === 'object' && !Array.isArray(part) && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('')
        if (text.trim()) ids.add(message.id)
    }
    return ids
}

async function ownedState(runtime: Parameters<typeof desktopForeman>[0], scope: z.infer<typeof desktopForemanFeedbackScopeSchema>) {
    const app = await desktopForeman(runtime)
    try { return await app.state(scope) } catch (error) {
        if (error instanceof DesktopHttpError && error.status === 404) throw error
        throw new DesktopHttpError(502, 'Could not read this Foreman conversation. Try again.')
    }
}

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const scope = scopeOf(new URL(request.url))
        const state = await ownedState(runtime, scope)
        if (state.chat.workspaceId !== scope.workspaceId || state.chat.chatId !== scope.chatId) throw new DesktopHttpError(404, 'Foreman conversation not found.')
        const saved = savedAssistantIds(state.messages)
        const votes = (await listDesktopForemanFeedback(await openDesktopDatabase(runtime.dataRoot), scope.workspaceId, scope.chatId)).filter(vote => saved.has(vote.messageId))
        return Response.json({ votes }, { headers: noStore })
    })
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopForemanFeedbackRateSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid feedback')
        const state = await ownedState(runtime, { workspaceId: parsed.data.workspaceId, chatId: parsed.data.chatId })
        if (state.chat.workspaceId !== parsed.data.workspaceId || state.chat.chatId !== parsed.data.chatId) throw new DesktopHttpError(404, 'Foreman conversation not found.')
        if (state.view.live) throw new DesktopHttpError(409, 'Wait for this Foreman reply to finish before rating it.')
        if (!savedAssistantIds(state.messages).has(parsed.data.messageId)) throw new DesktopHttpError(404, 'Message not found')
        const vote = await rateDesktopForemanFeedback(await openDesktopDatabase(runtime.dataRoot), parsed.data)
        return Response.json(vote, { headers: noStore })
    })
}

export function DELETE(request: Request) {
    return desktopRoute(request, async runtime => {
        const url = new URL(request.url)
        const scope = scopeOf(url)
        const id = url.searchParams.get('id')
        if (!id || !z.string().uuid().safeParse(id).success) throw new DesktopHttpError(400, 'Invalid feedback')
        await clearDesktopForemanFeedback(await openDesktopDatabase(runtime.dataRoot), scope.workspaceId, scope.chatId, id)
        return Response.json({ ok: true }, { headers: noStore })
    })
}
