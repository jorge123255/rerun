import { customProviderRequestSchema } from '@rerun/contracts'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { boundedText } from '@/lib/desktop/server/mcp/remote'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
export async function POST(request: Request) {
    try {
        const runtime = await authenticateDesktopRequest(request)
        assertDesktopWorkspaceAdmission(runtime)
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) throw new DesktopHttpError(415, 'Use JSON.')
        const parsed = customProviderRequestSchema.safeParse(await readDesktopJson(request, 64_000))
        if (!parsed.success) throw new DesktopHttpError(400, 'Send a valid custom provider request.')
        const current = await readDesktopRuntime()
        if (current.workspaceId !== runtime.workspaceId || current.launchNonce !== runtime.launchNonce || current.engine.origin !== runtime.engine.origin) {
            throw new DesktopHttpError(409, 'The app launch changed.')
        }
        assertDesktopWorkspaceAdmission(runtime)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35_000)])
        const result = await fetch(new URL('/desktop/custom-providers', runtime.engine.origin), {
            method: 'POST', signal, redirect: 'error', cache: 'no-store',
            headers: { authorization: `Bearer ${runtime.engine.apiKey}`, 'x-rerun-launch-nonce': runtime.launchNonce, 'content-type': 'application/json' },
            body: JSON.stringify(parsed.data),
        })
        return new Response(await boundedText(result, signal, 256_000), { status: result.status, headers })
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ error: error.message }, { status: error.status, headers })
        return Response.json({ error: 'Custom provider request unavailable. Retry the same request to recover its receipt.' }, { status: 503, headers })
    }
}
