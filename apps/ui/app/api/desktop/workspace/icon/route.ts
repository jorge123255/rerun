import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopWorkspaceIcon, writeDesktopWorkspaceIcon } from '@/lib/desktop/server/workspace-icon'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const catalogId = await readDesktopWorkspaceIcon(db)
        return Response.json({ catalogId }, { headers: { 'cache-control': 'no-store' } })
    })
}

const iconSelection = z.object({ catalogId: z.string().trim().min(1) })

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = iconSelection.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Pick one of the built-in illustrations.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        await writeDesktopWorkspaceIcon(db, parsed.data.catalogId)
        return Response.json({ catalogId: parsed.data.catalogId })
    })
}
