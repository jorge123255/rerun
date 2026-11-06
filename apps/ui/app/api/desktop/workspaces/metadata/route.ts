import { z } from 'zod'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopWorkspaceMetadataOutbox, acknowledgeDesktopWorkspaceMetadataOutbox } from '@/lib/desktop/server/workspaces/metadata'
export const dynamic = 'force-dynamic'
export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json({ workspaceId: runtime.workspaceId, launchNonce: runtime.launchNonce, pending: await readDesktopWorkspaceMetadataOutbox(await openDesktopDatabase(runtime.dataRoot)) }, { headers: { 'cache-control': 'no-store' } }))
}
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const body = z.strictObject({ requestId: z.string().uuid(), workspaceId: z.number().int().positive(), launchNonce: z.string().min(1) }).safeParse(await request.json().catch(() => null))
        if (!body.success || body.data.workspaceId !== runtime.workspaceId || body.data.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'The active workspace changed. Reopen settings.')
        await acknowledgeDesktopWorkspaceMetadataOutbox(await openDesktopDatabase(runtime.dataRoot), body.data.requestId)
        return Response.json({ ok: true })
    })
}
