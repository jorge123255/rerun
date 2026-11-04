import { CoworkerFileConflict, readCoworkerFile } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        try {
            const preview = await readCoworkerFile(runtime, agentId, new URL(request.url).searchParams.get('path') ?? '')
            return Response.json(preview, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof CoworkerFileConflict) {
                return Response.json({ error: error.message, conflict: true, current: error.current, ...(error.recovery && { recovery: error.recovery }) }, { status: 409, headers: { 'cache-control': 'no-store' } })
            }
            throw error
        }
    })
}
