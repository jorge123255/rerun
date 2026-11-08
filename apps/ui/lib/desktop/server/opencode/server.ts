import 'server-only'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { DesktopOpencodePublishError, publishDesktopOpencode, type DesktopOpencodePorts } from './publisher'

let ports: DesktopOpencodePorts | null = null

export function bindDesktopOpencodePorts(next: DesktopOpencodePorts | null): void {
    ports = next
}

const noStore = { 'Cache-Control': 'no-store' }

function httpStatus(outcome: unknown): number {
    if (!outcome || typeof outcome !== 'object' || !('status' in outcome)) return 200
    return outcome.status === 'saved' ? 200 : 409
}

// Loopback engine route. Unmounted ports are unavailable. GET never runs a model.
export async function handleDesktopOpencode(request: Request): Promise<Response> {
    if (!ports) return Response.json({ status: 'refused', code: 'unavailable', message: 'OpenCode is not mounted on this desktop.', sent: false }, { status: 503, headers: noStore })
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        if (request.method === 'GET') {
            const url = new URL(request.url)
            const workspaceId = Number(url.searchParams.get('workspaceId'))
            if (workspaceId !== runtime.workspaceId) return Response.json({ status: 'refused', code: 'workspace', message: 'OpenCode request belongs to another workspace.', sent: false }, { status: 409, headers: noStore })
            const outcome = await publishDesktopOpencode(ports, { action: 'catalog', workspaceId, connectionId: url.searchParams.get('connectionId') ?? '', requestId: url.searchParams.get('requestId') ?? 'catalog-read', selectedModelId: url.searchParams.get('selectedModelId') || 'go/deepseek-v4-pro' }, request.signal, runtime.launchNonce)
            return Response.json(outcome, { status: httpStatus(outcome), headers: noStore })
        }
        if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: noStore })
        const body = await request.json() as { workspaceId?: number; dispatch?: { workspaceId?: number } }
        const workspaceId = body.dispatch?.workspaceId ?? body.workspaceId
        if (workspaceId !== runtime.workspaceId) return Response.json({ status: 'refused', code: 'workspace', message: 'OpenCode request belongs to another workspace.', sent: false }, { status: 409, headers: noStore })
        const outcome = await publishDesktopOpencode(ports, body, request.signal, runtime.launchNonce)
        return Response.json(outcome, { status: httpStatus(outcome), headers: noStore })
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ status: 'refused', message: error.message, sent: false }, { status: error.status, headers: noStore })
        const message = error instanceof DesktopOpencodePublishError ? error.message : error instanceof Error && error.message ? error.message : 'OpenCode request failed.'
        return Response.json({ status: 'refused', message, sent: false }, { status: 409, headers: noStore })
    }
}
