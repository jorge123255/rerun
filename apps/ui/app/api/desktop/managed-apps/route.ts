import { desktopManagedAppsActionSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopManagedApps } from '@/lib/desktop/server/managed-apps/binding'
import { ManagedAppsError } from '@/lib/desktop/server/managed-apps/client'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const headers = { 'cache-control': 'no-store' }

// Managed apps in the Vault: whether a Composio key is kept, the apps on offer and the accounts signed in.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await (await openDesktopManagedApps(runtime)).view(), { headers }))
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopManagedAppsActionSchema.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Enter valid managed app settings.')
        assertDesktopWorkspaceAdmission(runtime)
        try {
            return Response.json(await (await openDesktopManagedApps(runtime)).act(parsed.data, AbortSignal.any([request.signal, AbortSignal.timeout(90_000)])), { headers })
        } catch (error) {
            // Composio's own words may carry the key or an account detail, so only these fixed messages leave.
            if (error instanceof ManagedAppsError) throw new DesktopHttpError(error.status === 401 || error.status === 403 ? 400 : error.status === 400 || error.status === 409 ? error.status : 502, error.message)
            throw error
        }
    })
}
