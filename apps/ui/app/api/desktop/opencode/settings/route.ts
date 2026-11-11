import { desktopOpencodeConnectionChange, desktopOpencodeConnectionView } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { boundedText } from '@/lib/desktop/server/mcp/remote'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'

export const runtime = 'nodejs'

const view = z.object({ connection: desktopOpencodeConnectionView.nullable() })
const problem = z.object({ error: z.string().min(1).max(350) })
const headers = { 'cache-control': 'no-store' }

function connection(request: Request, method: 'GET' | 'POST') {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const change = method === 'POST' ? desktopOpencodeConnectionChange.safeParse(await readDesktopJson(request, 96_000)) : null
        if (change && !change.success) throw new DesktopHttpError(400, 'Send a valid OpenCode connection change.')
        if ((change?.data.workspaceId ?? Number(query.get('workspaceId'))) !== runtime.workspaceId)
            throw new DesktopHttpError(409, 'OpenCode request belongs to another workspace.')
        const current = await readDesktopRuntime()
        if (current.workspaceId !== runtime.workspaceId || current.launchNonce !== runtime.launchNonce || current.engine.origin !== runtime.engine.origin)
            throw new DesktopHttpError(409, 'The app launch changed.')
        assertDesktopWorkspaceAdmission(runtime)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
        const response = await fetch(new URL('/desktop/opencode/connection', runtime.engine.origin), {
            method, signal, redirect: 'error', cache: 'no-store',
            headers: { authorization: `Bearer ${runtime.engine.apiKey}`, 'x-rerun-launch-nonce': runtime.launchNonce, 'content-type': 'application/json' },
            body: change ? JSON.stringify(change.data) : undefined,
        })
        const body: unknown = JSON.parse(await boundedText(response, signal, 96_000))
        if (!response.ok) {
            const parsed = problem.safeParse(body)
            if ((response.status === 400 || response.status === 409) && parsed.success)
                return Response.json(parsed.data, { status: response.status, headers })
            throw new DesktopHttpError(503, 'OpenCode credential storage is unavailable.')
        }
        const parsed = view.parse(body)
        assertDesktopWorkspaceAdmission(runtime)
        if (parsed.connection && parsed.connection.workspaceId !== runtime.workspaceId)
            throw new DesktopHttpError(409, 'OpenCode request belongs to another workspace.')
        return Response.json(parsed, { headers })
    })
}

export const GET = (request: Request) => connection(request, 'GET')
export const POST = (request: Request) => connection(request, 'POST')
