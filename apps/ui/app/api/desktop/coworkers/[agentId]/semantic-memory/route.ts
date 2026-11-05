import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopSemanticMemory, recallDesktopSemanticMemory } from '@/lib/desktop/server/semantic-memory/handler'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const status = await readDesktopSemanticMemory(runtime, (await params).agentId)
        return Response.json(status, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const raw = await request.text()
        if (raw.length > 4096) throw new DesktopHttpError(400, 'Enter a shorter search.')
        let body: unknown = null
        if (raw) {
            try { body = JSON.parse(raw) }
            catch { throw new DesktopHttpError(400, 'Enter a search query and a valid result limit.') }
        }
        const result = await recallDesktopSemanticMemory(runtime, (await params).agentId, body)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
