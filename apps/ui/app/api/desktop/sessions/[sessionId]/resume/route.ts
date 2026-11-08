import { resumeDesktopChat } from '@/lib/desktop/server/chat-resume'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

// Reattach to the live run for this conversation. A finished, foreign, or
// unbuffered run is an explicit unavailable response, never an empty success stream.
export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { sessionId } = await params
        const runId = new URL(request.url).searchParams.get('runId') ?? ''
        const result = await resumeDesktopChat(runtime, sessionId, runId)
        if (result.kind === 'unavailable') {
            return new Response(null, {
                status: 204,
                headers: { 'x-rerun-resume': 'unavailable', 'x-rerun-resume-reason': result.reason, 'cache-control': 'no-store' },
            })
        }
        return result.response
    })
}
