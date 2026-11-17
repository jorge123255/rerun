import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { markDesktopCompletionsRead, readDesktopCompletions } from '@/lib/desktop/server/completed-actions'
import { desktopRoute } from '@/lib/desktop/server/http'
import { markDesktopPendingInboxRead, readDesktopPendingInbox } from '@/lib/desktop/server/pending-inbox'
import { phoneInboxItems, phoneInboxReadTargets } from '@/lib/desktop/server/phone-inbox'

export const dynamic = 'force-dynamic'

const options = { headers: { 'cache-control': 'no-store' } }
const readInput = z.object({ ids: z.array(z.string().min(3).max(8200)).min(1).max(500) }).strict()

// The Mac's own Actions inbox, for the pairing service to hand to an approved phone: the pending
// requests with the inbox's read receipts already taken off, and the unread results.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const [pending, done] = await Promise.all([readDesktopPendingInbox(runtime), readDesktopCompletions(runtime)])
        return Response.json({ items: phoneInboxItems(pending.items, done.items), partial: pending.unavailableAgentIds.length > 0 || done.unavailableAgentIds.length > 0 }, options)
    })
}

// Marks rows read by the Mac's own rule: exactly the rows named, found again in the inbox as it
// stands now, through the two mark-read paths the Mac's inbox uses. Reading a pending row never
// answers it.
export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = readInput.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Name the rows to mark read.')
        const [pending, done] = await Promise.all([readDesktopPendingInbox(runtime), readDesktopCompletions(runtime)])
        const targets = phoneInboxReadTargets(parsed.data.ids, pending.items, done.items)
        const [marked, finished] = await Promise.all([
            targets.items.length ? markDesktopPendingInboxRead(runtime, { items: targets.items }) : { marked: 0, failedIds: [] },
            targets.completionIds.length ? markDesktopCompletionsRead(runtime, { completionIds: targets.completionIds }) : { marked: 0 },
        ])
        return Response.json({ marked: marked.marked + finished.marked }, options)
    })
}
