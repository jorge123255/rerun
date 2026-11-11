import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { companyBriefModelSchema, foremanAlternateRequestSchema, foremanChatRefSchema, foremanBindingSchema, foremanNavigationIntentSchema, foremanBriefSchema, foremanQuestionGuardSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { foremanTurn, foremanTurnWire } from '@/lib/desktop/server/foreman/chat-store'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopForemanVoice } from '@/lib/desktop/server/foreman-voice/binding'
import { authorizeForemanAlternate } from '@/lib/desktop/server/foreman-alternates/binding'
export const runtime = 'nodejs'
const base = z.object({ launchNonce: z.string(), binding: foremanBindingSchema })
const schema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('brief_model'), launchNonce: z.string(), chat: foremanChatRefSchema, model: companyBriefModelSchema }),
    z.strictObject({ action: z.literal('binding'), launchNonce: z.string(), identity: z.strictObject({ engineAgentId: z.literal('foreman'), sessionId: z.string(), runId: z.uuid() }) }),
    z.strictObject({ action: z.literal('admit'), launchNonce: z.string(), turn: z.strictObject({ binding: foremanBindingSchema, sessionId: z.uuid(), text: z.string().max(20_000), brief: foremanBriefSchema, question: foremanQuestionGuardSchema.optional() }) }),
    z.strictObject({ action: z.literal('alternate'), launchNonce: z.string(), operation: z.enum(['prepare', 'lookup']), target: foremanAlternateRequestSchema }),
    base.extend({ action: z.literal('show_plan'), toolCallId: z.string().min(1).max(256), input: z.unknown() }).strict(),
    base.extend({ action: z.literal('navigate'), eventId: z.string().min(1).max(128), intent: foremanNavigationIntentSchema }).strict(),
    base.extend({ action: z.literal('discover'), url: z.url().max(2048) }).strict(),
])
export async function POST(request: Request) {
    try {
        const runtime = await authenticateDesktopEngineRequest(request), input = schema.parse(await readDesktopJson(request, 48 * 1024))
        if (input.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Foreman launch changed.')
        if (input.action === 'alternate') {
            await authorizeForemanAlternate(runtime, input.operation, input.target)
            return Response.json({ ok: true })
        }
        const app = await desktopForeman(runtime)
        if (input.action === 'brief_model') return Response.json({ ok: isDeepStrictEqual(await app.modelChoice(input.chat), input.model) })
        if (input.action === 'admit') {
            const record = await foremanTurn(app.db, input.turn.binding.runId)
            if (!record || !['pending', 'admitted'].includes(record.status) || !isDeepStrictEqual(foremanTurnWire(record.body), input.turn)) throw new DesktopHttpError(409, 'Foreman admission changed.')
            await (await desktopForemanVoice(runtime, app.voiceShutdownSignal)).assertAdmission(input.turn, request.signal)
            return Response.json({ ok: true })
        }
        if (input.action === 'binding') {
            const record = await foremanTurn(app.db, input.identity.runId)
            if (!record || record.body.sessionId !== input.identity.sessionId || !await app.isLive(record.body.binding)) throw new DesktopHttpError(409, 'Foreman binding changed.')
            return Response.json({ binding: record.body.binding, discovery: true })
        }
        if (!await app.isLive(input.binding)) throw new DesktopHttpError(409, 'This Foreman run is no longer current.')
        if (input.action === 'show_plan') return Response.json(await app.core.recordShownPlan(input.binding, input.toolCallId, input.input))
        if (input.action === 'navigate') return Response.json(await app.core.emitNavigation(input.binding, input.intent, input.eventId))
        const discovery = await app.core.startDiscovery(input.binding, input.url)
        const stop = () => { void app.core.stopDiscovery(discovery.discoveryId) }
        request.signal.addEventListener('abort', stop, { once: true })
        if (request.signal.aborted) stop()
        try {
            await app.core.waitDiscovery(discovery.discoveryId)
            request.signal.throwIfAborted()
            return Response.json((await app.core.readView({ workspaceId: input.binding.workspaceId, chatId: input.binding.chatId })).discovery)
        } finally { request.signal.removeEventListener('abort', stop) }
    } catch (error) {
        return Response.json({ error: 'This Foreman tool request could not be applied.' }, { status: error instanceof DesktopHttpError ? error.status : 409 })
    }
}
