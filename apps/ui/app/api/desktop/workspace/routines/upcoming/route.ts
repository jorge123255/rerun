import { desktopUpcomingRoutinesSchema } from '@rerun/contracts'
import { desktopRoute } from '@/lib/desktop/server/http'
import { createDesktopWorkspaceRoutinesReader } from '@/lib/desktop/server/workspace-routines/reader'
import { desktopWorkspaceRoutinesAuthority } from '@/lib/desktop/server/workspace-routines/runtime'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const reader = createDesktopWorkspaceRoutinesReader(await desktopWorkspaceRoutinesAuthority(runtime))
        const upcoming = await reader.upcoming(request.signal)
        return Response.json(desktopUpcomingRoutinesSchema.parse(upcoming), { headers: { 'Cache-Control': 'no-store' } })
    })
}
