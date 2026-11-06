import { admitDesktopChatDocuments } from '@/lib/desktop/server/document-attachments/chat'
import { desktopQueueScopeSchema, desktopQueueWriteSchema } from '@/lib/desktop/queued-message'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopQueue, writeDesktopQueue } from '@/lib/desktop/server/queued-message'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ agentId: string }> }

export async function GET(request: Request, { params }: Params) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopQueueScopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a conversation.')
        return Response.json(await readDesktopQueue(await openDesktopDatabase(runtime.dataRoot), (await params).agentId, parsed.data), { headers: { 'cache-control': 'no-store' } })
    })
}

export async function PUT(request: Request, { params }: Params) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopQueueWriteSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid queued message.')
        const db = await openDesktopDatabase(runtime.dataRoot), agentId = (await params).agentId
        if (parsed.data.action === 'enqueue' && parsed.data.item.documents) await admitDesktopChatDocuments(runtime, db, { agentId, ...parsed.data.scope, documents: parsed.data.item.documents })
        return Response.json(await writeDesktopQueue(db, agentId, parsed.data))
    })
}
