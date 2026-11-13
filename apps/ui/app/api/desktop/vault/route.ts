import { desktopVaultMutation } from '@/lib/desktop/vault'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { openDesktopVault } from '@/lib/desktop/server/vault/binding'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await (await openDesktopVault(runtime)).list(), { headers }))
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopVaultMutation.safeParse(await readDesktopJson(request, 128 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'Enter valid Vault settings.')
        const listing = await (await openDesktopVault(runtime)).mutate(parsed.data, () => {
            request.signal.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
        })
        return Response.json(listing, { headers })
    })
}
