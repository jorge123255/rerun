import 'server-only'
import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M, desktopScheduleToolNoticeSchema, type DesktopScheduleToolNotice } from '../../../../../../packages/contracts/src/desktop-schedule-tools.ts'
import { DesktopHttpError } from '../auth'

const notices = new Map<string, DesktopScheduleToolNotice[]>()
let wired = false

/** Root calls this when the engine can publish committed routine edits. Unwired requests fail closed. */
export function bindDesktopScheduleToolNotices(): void {
    wired = true
}

export function desktopScheduleToolNoticesWired(): boolean {
    return wired
}

export function acceptDesktopScheduleToolNotice(notice: DesktopScheduleToolNotice): void {
    if (!wired) throw new DesktopHttpError(503, M.unwired)
    const parsed = desktopScheduleToolNoticeSchema.parse(notice)
    const list = notices.get(parsed.localAgentId) ?? []
    list.push(parsed)
    notices.set(parsed.localAgentId, list.slice(-50))
}

export function listDesktopScheduleToolNotices(localAgentId: string): DesktopScheduleToolNotice[] {
    return [...(notices.get(localAgentId) ?? [])]
}

export async function desktopScheduleToolNoticeRequest(request: Request, agentId: string): Promise<Response> {
    try {
        if (!wired) throw new DesktopHttpError(503, M.unwired)
        if (request.method === 'GET') {
            return Response.json({ notices: listDesktopScheduleToolNotices(agentId) }, { headers: { 'Cache-Control': 'no-store' } })
        }
        if (request.method === 'POST') {
            const body = desktopScheduleToolNoticeSchema.parse(await request.json())
            if (body.localAgentId !== agentId) throw new DesktopHttpError(403, M.deleting)
            acceptDesktopScheduleToolNotice(body)
            return Response.json({ saved: true }, { headers: { 'Cache-Control': 'no-store' } })
        }
        throw new DesktopHttpError(405, 'Unsupported schedule notice')
    } catch (error) {
        const status = error instanceof DesktopHttpError ? error.status : 400
        const message = error instanceof DesktopHttpError ? error.message : 'Schedule notice could not be read.'
        return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
    }
}
