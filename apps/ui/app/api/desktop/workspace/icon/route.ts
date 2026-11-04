import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopWorkspaceIconUpdateSchema, readDesktopWorkspaceIcon, writeDesktopWorkspaceIcon } from '@/lib/desktop/server/workspace-icon'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const catalogId = await readDesktopWorkspaceIcon(db)
        return Response.json({ catalogId }, { headers: { 'cache-control': 'no-store' } })
    })
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopWorkspaceIconUpdateSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, `Enter a workspace name between 1 and ${WORKSPACE_NAME_MAX} characters and choose a built-in illustration.`)
        const db = await openDesktopDatabase(runtime.dataRoot)
        const saved = await writeDesktopWorkspaceIcon(db, parsed.data)
        return Response.json(saved, { headers: { 'cache-control': 'no-store' } })
    })
}
