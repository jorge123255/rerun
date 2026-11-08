import 'server-only'
import { authenticateDesktopRequest, DesktopHttpError } from '../server/auth'
import { handleDesktopOpencode } from '../server/opencode/server'
import type { DesktopOpencodeAuthority } from '../server/opencode/authority'

let authority: DesktopOpencodeAuthority | null = null
export function bindDesktopOpencodeUiAuthority(next: DesktopOpencodeAuthority | null): void {
    authority = next
}

async function guarded(work: () => Promise<Response>): Promise<Response> {
    try {
        return await work()
    } catch (error) {
        const status = error instanceof DesktopHttpError ? error.status : 503
        const message = status === 401 ? 'Unauthorized' : status === 409 ? 'OpenCode request is no longer current.' : 'OpenCode is unavailable.'
        return Response.json({ status: 'refused', code: 'unavailable', message, sent: false }, { status, headers: { 'cache-control': 'no-store' } })
    }
}

export async function handleDesktopOpencodeUi(request: Request): Promise<Response> {
    return guarded(async () => {
        const runtime = await authenticateDesktopRequest(request)
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${runtime.engine.apiKey}`)
        return handleDesktopOpencode(new Request(request, { headers }))
    })
}

export async function handleDesktopOpencodeConnection(request: Request): Promise<Response> {
    return guarded(async () => {
        const runtime = await authenticateDesktopRequest(request)
        if (!authority) return Response.json({ status: 'refused', code: 'unavailable', message: 'OpenCode is not mounted on this desktop.', sent: false }, { status: 503, headers: { 'cache-control': 'no-store' } })
        const url = new URL(request.url)
        const workspaceId = Number(url.searchParams.get('workspaceId'))
        const connectionId = url.searchParams.get('connectionId') ?? ''
        if (workspaceId !== runtime.workspaceId || !connectionId) throw new DesktopHttpError(409, 'OpenCode request belongs to another workspace.')
        const snapshot = await authority.current({ workspaceId, connectionId }, request.signal)
        if (snapshot && snapshot.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'OpenCode launch no longer matches this desktop.')
        return Response.json(snapshot ? { ...snapshot, apiKey: snapshot.apiKey ? 'oc_sk_write_only' : null } : null, { headers: { 'cache-control': 'no-store' } })
    })
}
