import { z } from 'zod'
import { reconcileDesktopDuplicates } from '@/lib/desktop/server/coworker-duplicate'
import { reconcileDesktopRenames } from '@/lib/desktop/server/coworker-rename'
import { reconcileDesktopEnabled } from '@/lib/desktop/server/coworker-enabled'
import { engineOf } from '@/lib/desktop/server/settings'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopCoworker } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'
import { listDesktopAgents } from '@/lib/desktop/server/store'
import { desktopAgentView } from '@/lib/desktop/server/views'

const inputSchema = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(2000).optional() })

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        await reconcileDesktopRenames(db, engineOf(runtime), runtime.launchNonce)
        await reconcileDesktopDuplicates(db, engineOf(runtime))
        await reconcileDesktopEnabled(db, engineOf(runtime))
        const agents = await listDesktopAgents(db)
        return Response.json({ agents: agents.map(desktopAgentView) })
    })
}

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'A coworker name of 1–60 characters is required')
        const agent = await createDesktopCoworker(runtime, parsed.data)
        return Response.json({ agent: desktopAgentView(agent) }, { status: 201 })
    })
}
