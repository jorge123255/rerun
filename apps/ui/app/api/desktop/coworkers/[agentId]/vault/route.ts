import { desktopCoworkerVaultMutation } from '@/lib/desktop/vault'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { openDesktopVault } from '@/lib/desktop/server/vault/binding'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const vault = await openDesktopVault(runtime)
        return Response.json(await vault.forCoworker(agentId), { headers })
    })
}

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const parsed = desktopCoworkerVaultMutation.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Enter a valid Vault assignment.')
        const vault = await openDesktopVault(runtime)
        const listing = await vault.assignCoworker(agentId, parsed.data, () => {
            request.signal.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
        })
        return Response.json(listing, { headers })
    })
}
