import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { CoworkerFileConflict, saveCoworkerFile } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Save edited text over an existing .txt/.md file (FileDetail → writeFileAction with baseHash). */
export function PUT(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const body = await request.json().catch(() => null) as { path?: unknown; content?: unknown; baseHash?: unknown; identity?: unknown } | null
        if (!body || typeof body.path !== 'string' || typeof body.content !== 'string' || typeof body.baseHash !== 'string' || body.baseHash.length === 0) {
            throw new DesktopHttpError(400, 'Send a path, the new text and the hash the editor opened.')
        }
        if (body.identity !== undefined && (typeof body.identity !== 'string' || !/^\d+:\d+$/.test(body.identity))) {
            throw new DesktopHttpError(400, 'Send a path, the new text and the hash the editor opened.')
        }
        try {
            const saved = await saveCoworkerFile(runtime, agentId, body.path, body.content, body.baseHash, body.identity)
            return Response.json(saved, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof CoworkerFileConflict) {
                return Response.json({ error: error.message, conflict: true, current: error.current, ...(error.stale ? { stale: true } : {}), ...(error.recovery && { recovery: error.recovery }) }, { status: 409, headers: { 'cache-control': 'no-store' } })
            }
            throw error
        }
    })
}
