import { z } from 'zod'
import { desktopModelPickSchema } from '@/lib/desktop/chat-model'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopProviders } from '@/lib/desktop/server/settings'
import { readDesktopBackupModelView, saveDesktopBackupModel } from '@/lib/desktop/server/usage-gate-model'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const change = z.object({ backup: desktopModelPickSchema.nullable() }).strict()

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await readDesktopBackupModelView(runtime, (await readDesktopProviders(runtime)).connections), { headers }))
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = change.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a model, or no backup.')
        const { connections } = await readDesktopProviders(runtime)
        await saveDesktopBackupModel(runtime, connections, parsed.data.backup)
        return Response.json(await readDesktopBackupModelView(runtime, connections), { headers })
    })
}
