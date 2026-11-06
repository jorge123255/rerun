import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { foremanBindingSchema, foremanNavigationIntentSchema, foremanBriefSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { foremanTurn } from '@/lib/desktop/server/foreman/chat-store'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
export const runtime = 'nodejs'
const base = z.object({ launchNonce: z.string(), binding: foremanBindingSchema })
const schema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('binding'), launchNonce: z.string(), identity: z.strictObject({ engineAgentId: z.literal('foreman'), sessionId: z.string(), runId: z.uuid() }) }),
    z.strictObject({ action: z.literal('admit'), launchNonce: z.string(), turn: z.strictObject({ binding: foremanBindingSchema, sessionId: z.uuid(), text: z.string().max(20_000), brief: foremanBriefSchema }) }),
    base.extend({ action: z.literal('show_plan'), toolCallId: z.string().min(1).max(256), input: z.unknown() }).strict(),
    base.extend({ action: z.literal('navigate'), eventId: z.string().min(1).max(128), intent: foremanNavigationIntentSchema }).strict(),
    base.extend({ action: z.literal('discover'), url: z.url().max(2048) }).strict(),
])
export async function POST(request: Request) {
    try {
        const runtime = await authenticateDesktopEngineRequest(request), input = schema.parse(await readDesktopJson(request, 32 * 1024))
        if (input.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Foreman launch changed.')
        const app = await desktopForeman(runtime)
        if (input.action === 'admit') {
            const record = await foremanTurn(app.db, input.turn.binding.runId)
            if (!record || !['pending', 'admitted'].includes(record.status) || !isDeepStrictEqual(record.body, input.turn)) throw new DesktopHttpError(409, 'Foreman admission changed.')
            return Response.json({ ok: true })
        }
        if (input.action === 'binding') {
            const record = await foremanTurn(app.db, input.identity.runId)
            if (!record || record.body.sessionId !== input.identity.sessionId || !await app.isLive(record.body.binding)) throw new DesktopHttpError(409, 'Foreman binding changed.')
            return Response.json({ binding: record.body.binding, discovery: false })
        }
        if (!await app.isLive(input.binding)) throw new DesktopHttpError(409, 'This Foreman run is no longer current.')
        if (input.action === 'show_plan') return Response.json(await app.core.recordShownPlan(input.binding, input.toolCallId, input.input))
        if (input.action === 'navigate') return Response.json(await app.core.emitNavigation(input.binding, input.intent, input.eventId))
        return Response.json(await app.core.startDiscovery(input.binding, input.url))
    } catch (error) {
        return Response.json({ error: 'This Foreman tool request could not be applied.' }, { status: error instanceof DesktopHttpError ? error.status : 409 })
    }
}
