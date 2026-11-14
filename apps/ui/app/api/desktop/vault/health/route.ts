import { desktopVaultHealthTarget } from '@/lib/desktop/vault'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { getDesktopRemoteMcpService } from '@/lib/desktop/server/mcp-binding'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { openDesktopVault } from '@/lib/desktop/server/vault/binding'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        assertDesktopWorkspaceAdmission(runtime)
        const input = desktopVaultHealthTarget.safeParse(await readDesktopJson(request, 4096))
        if (!input.success) throw new DesktopHttpError(400, 'Invalid Vault connection check.')
        const { id, revision } = input.data
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const service = await getDesktopRemoteMcpService(runtime)
        await service.checkVaultCatalogHealth(id, revision, signal)
        signal.throwIfAborted()
        assertDesktopWorkspaceAdmission(runtime)
        return Response.json(await (await openDesktopVault(runtime)).list(), { headers: { 'cache-control': 'no-store' } })
    })
}
