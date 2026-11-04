import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopCompletionReadSchema, markDesktopCompletionsRead } from '@/lib/desktop/server/completed-actions'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

// Explicit authenticated mark-read: the client acknowledges exactly the completion IDs it
// displayed, so a newer arrival in the same conversation or scheduled task is never cleared.
export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopCompletionReadSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Mark-read needs the exact completion IDs to acknowledge.')
        return Response.json(await markDesktopCompletionsRead(runtime, parsed.data))
    })
}
