import { getAgent } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { DESKTOP_SCHEDULE_PARSER_INVALID, DESKTOP_SCHEDULE_PARSER_UNAVAILABLE, desktopScheduleDescriptionRequestSchema, desktopScheduleParseResultSchema } from '@/lib/desktop/schedule-description'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ agentId: string }> }

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const parsed = desktopScheduleDescriptionRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid schedule description, time, timezone and model selection.')
        const owner = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
        if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
        const detail = await getAgent(engineOf(runtime), owner.engineAgentId)
        if (detail.id !== owner.engineAgentId) throw new DesktopHttpError(409, 'Coworker identity mismatch')
        let response: Response
        try {
            response = await fetch(`${runtime.engine.origin}/agents/${encodeURIComponent(owner.engineAgentId)}/schedules/describe`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(parsed.data), redirect: 'error', cache: 'no-store',
                signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
            })
        } catch (error) {
            if (request.signal.aborted) throw error
            return Response.json({ status: 'unavailable', message: DESKTOP_SCHEDULE_PARSER_UNAVAILABLE }, { headers: { 'cache-control': 'no-store' } })
        }
        const body = await response.json().catch(() => null)
        if (!response.ok) return Response.json({ status: 'unavailable', message: DESKTOP_SCHEDULE_PARSER_UNAVAILABLE }, { headers: { 'cache-control': 'no-store' } })
        const result = desktopScheduleParseResultSchema.safeParse(body)
        if (!result.success) return Response.json({ status: 'invalid', message: DESKTOP_SCHEDULE_PARSER_INVALID }, { headers: { 'cache-control': 'no-store' } })
        return Response.json(result.data, { headers: { 'cache-control': 'no-store' } })
    })
}
