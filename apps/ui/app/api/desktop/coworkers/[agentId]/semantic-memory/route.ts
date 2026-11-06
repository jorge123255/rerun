import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopSemanticMemory, recallDesktopSemanticMemory } from '@/lib/desktop/server/semantic-memory/handler'
import { boundedText } from '@/lib/desktop/server/mcp/remote'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const status = await readDesktopSemanticMemory(runtime, (await params).agentId, request.signal)
        return Response.json(status, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        request.signal.throwIfAborted()
        const raw = await boundedText(new Response(request.body), request.signal, 4096)
        request.signal.throwIfAborted()
        if (raw.length > 4096) throw new DesktopHttpError(400, 'Enter a shorter search.')
        let body: unknown = null
        if (raw) {
            try { body = JSON.parse(raw) }
            catch { throw new DesktopHttpError(400, 'Enter a search query and a valid result limit.') }
        }
        const result = await recallDesktopSemanticMemory(runtime, (await params).agentId, body, request.signal)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
