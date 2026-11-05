import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { maintainDesktopSemanticMemory } from '@/lib/desktop/server/semantic-memory/handler'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const raw = await request.text()
        if (raw.length > 4096) throw new DesktopHttpError(400, 'Unknown semantic index request.')
        let body: unknown = null
        try { body = raw ? JSON.parse(raw) : null }
        catch { throw new DesktopHttpError(400, 'Unknown semantic index request.') }
        const status = await maintainDesktopSemanticMemory(runtime, (await params).agentId, body)
        return Response.json(status, { headers: { 'cache-control': 'no-store' } })
    })
}
