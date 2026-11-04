import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopPendingInboxReadSchema, markDesktopPendingInboxRead } from '@/lib/desktop/server/pending-inbox'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

// Explicit authenticated mark-read: the client acknowledges exactly the pending items it displayed,
// so a newer request in the same conversation is never cleared. The server revalidates each item
// against the session's current pending request and reports any failures back in `failedIds`.
export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopPendingInboxReadSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Mark-read needs the exact pending items to acknowledge.')
        return Response.json(await markDesktopPendingInboxRead(runtime, parsed.data))
    })
}
