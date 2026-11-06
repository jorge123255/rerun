import 'server-only'
import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M, desktopScheduleToolNoticeSchema, type DesktopScheduleToolNotice } from '@rerun/contracts'
import { authenticateDesktopRequest, authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent } from '../store'
import { boundedText } from '../mcp/remote'

const noticeKey = Symbol.for('rerun.desktop.schedule-tool-notices.v1')
const shared = globalThis as unknown as Record<symbol, { notices: Map<string, DesktopScheduleToolNotice[]>; wired: boolean }>
const state = shared[noticeKey] ??= { notices: new Map(), wired: false }
const namespace = (runtime: { dataRoot: string; launchNonce?: string }) => `${runtime.dataRoot}\0${runtime.launchNonce ?? ''}`

/** Root calls this when the engine can publish committed routine edits. Unwired requests fail closed. */
export function bindDesktopScheduleToolNotices(): void {
    state.wired = true
}

export function desktopScheduleToolNoticesWired(): boolean {
    return state.wired
}

export function acceptDesktopScheduleToolNotice(notice: DesktopScheduleToolNotice, scope = ''): void {
    if (!state.wired) throw new DesktopHttpError(503, M.unwired)
    const parsed = desktopScheduleToolNoticeSchema.parse(notice)
    const key = `${scope}\0${parsed.localAgentId}`
    const list = state.notices.get(key) ?? []
    list.push(parsed)
    state.notices.set(key, list.slice(-50))
}

export function listDesktopScheduleToolNotices(localAgentId: string, scope = ''): DesktopScheduleToolNotice[] {
    return [...(state.notices.get(`${scope}\0${localAgentId}`) ?? [])]
}

export async function desktopScheduleToolNoticeRequest(request: Request, agentId: string): Promise<Response> {
    try {
        const runtime = request.method === 'POST' ? await authenticateDesktopEngineRequest(request) : await authenticateDesktopRequest(request)
        const owner = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
        if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
        if (request.method === 'GET') {
            return Response.json({ notices: listDesktopScheduleToolNotices(agentId, namespace(runtime)).map(({ engineAgentId: _private, ...value }) => value) }, { headers: { 'Cache-Control': 'no-store' } })
        }
        if (request.method === 'POST') {
            const body = desktopScheduleToolNoticeSchema.parse(JSON.parse(await boundedText(new Response(request.body), AbortSignal.any([request.signal, AbortSignal.timeout(5000)]), 16000)))
            if (body.localAgentId !== agentId || body.engineAgentId !== owner.engineAgentId) throw new DesktopHttpError(403, M.deleting)
            bindDesktopScheduleToolNotices()
            acceptDesktopScheduleToolNotice(body, namespace(runtime))
            return Response.json({ saved: true }, { headers: { 'Cache-Control': 'no-store' } })
        }
        throw new DesktopHttpError(405, 'Unsupported schedule notice')
    } catch (error) {
        const status = error instanceof DesktopHttpError ? error.status : 400
        const message = error instanceof DesktopHttpError ? error.message : 'Schedule notice could not be read.'
        return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
    }
}
