import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DESKTOP_FOREMAN_TURN_MAX_BYTES, companyBriefModelSchema, desktopForemanTurnSchema, foremanAlternateRequestSchema, foremanChatRefSchema, foremanBindingSchema, foremanNavigationIntentSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { foremanTurn, foremanTurnWire, ownedForemanDispatch } from '@/lib/desktop/server/foreman/chat-store'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { desktopForemanVoice } from '@/lib/desktop/server/foreman-voice/binding'
import { readGrantedForemanWorkspaceSnapshot } from '@/lib/desktop/server/foreman-workspace-reads'
import { authorizeForemanAlternate } from '@/lib/desktop/server/foreman-alternates/binding'
import { materializeDesktopChatDocuments } from '@/lib/desktop/server/document-attachments/chat'
export const runtime = 'nodejs'
const base = z.object({ launchNonce: z.string(), binding: foremanBindingSchema })
const turnRequest = z.strictObject({ launchNonce: z.string(), turn: desktopForemanTurnSchema })
const schema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('brief_model'), launchNonce: z.string(), chat: foremanChatRefSchema, model: companyBriefModelSchema }),
    z.strictObject({ action: z.literal('binding'), launchNonce: z.string(), identity: z.strictObject({ engineAgentId: z.literal('foreman'), sessionId: z.string(), runId: z.uuid() }) }),
    turnRequest.extend({ action: z.literal('admit') }),
    turnRequest.extend({ action: z.literal('documents') }),
    z.strictObject({ action: z.literal('alternate'), launchNonce: z.string(), operation: z.enum(['prepare', 'lookup', 'start', 'stop']), target: foremanAlternateRequestSchema }),
    base.extend({ action: z.literal('show_plan'), toolCallId: z.string().min(1).max(256), input: z.unknown() }).strict(),
    base.extend({ action: z.literal('navigate'), eventId: z.string().min(1).max(128), intent: foremanNavigationIntentSchema }).strict(),
    base.extend({ action: z.literal('discover'), url: z.url().max(2048) }).strict(),
    base.extend({ action: z.literal('workspace_snapshot') }).strict(),
])
export async function POST(request: Request) {
    try {
        const runtime = await authenticateDesktopEngineRequest(request), input = schema.parse(await readDesktopJson(request, DESKTOP_FOREMAN_TURN_MAX_BYTES))
        if (input.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Foreman launch changed.')
        if (input.action === 'alternate') {
            return Response.json(await authorizeForemanAlternate(runtime, input.operation, input.target))
        }
        const app = await desktopForeman(runtime)
        if (input.action === 'brief_model') return Response.json({ ok: isDeepStrictEqual(await app.modelChoice(input.chat), input.model) })
        if (input.action === 'admit' || input.action === 'documents') {
            const record = await foremanTurn(app.db, input.turn.binding.runId)
            if (!record || !['pending', 'admitted'].includes(record.status) || !isDeepStrictEqual(foremanTurnWire(record.body), input.turn)) throw new DesktopHttpError(409, 'Foreman admission changed.')
            await (await desktopForemanVoice(runtime, app.voiceShutdownSignal)).assertAdmission(input.turn, request.signal)
            if (input.action === 'documents') {
                if (!record.body.documents) throw new DesktopHttpError(409, 'This Foreman turn has no attachments.')
                const { sessionId, binding } = record.body
                await ownedForemanDispatch(runtime, app.db, sessionId, binding.runId)
                const documents = await materializeDesktopChatDocuments(runtime, record.body.documents, request.signal)
                await ownedForemanDispatch(runtime, app.db, sessionId, binding.runId)
                return Response.json({ documents }, { headers: { 'cache-control': 'no-store' } })
            }
            return Response.json({ ok: true })
        }
        if (input.action === 'binding') {
            const record = await foremanTurn(app.db, input.identity.runId)
            if (!record || record.body.sessionId !== input.identity.sessionId || !await app.isLive(record.body.binding)) throw new DesktopHttpError(409, 'Foreman binding changed.')
            return Response.json({ binding: record.body.binding, discovery: true })
        }
        if (!await app.isLive(input.binding)) throw new DesktopHttpError(409, 'This Foreman run is no longer current.')
        if (input.action === 'workspace_snapshot') {
            const snapshot = await readGrantedForemanWorkspaceSnapshot(runtime, input.binding.workspaceId, request.signal)
            request.signal.throwIfAborted()
            if (!await app.isLive(input.binding)) throw new DesktopHttpError(409, 'This Foreman run is no longer current.')
            return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } })
        }
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
