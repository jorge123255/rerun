import { desktopVaultMutation } from '@/lib/desktop/vault'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { getDesktopRemoteMcpService } from '@/lib/desktop/server/mcp-binding'
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
        const vault = await openDesktopVault(runtime)
        const guard = () => {
            request.signal.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
        }
        const before = parsed.data.operation === 'add-app' ? new Set((await vault.list()).entries.map(entry => entry.id)) : null
        const listing = await vault.mutate(parsed.data, guard)
        // An app refuses a wrong key only when it is called: the account just added is dialed once,
        // so the person who typed the key hears it now instead of the coworker at its first run.
        // Only a refusal undoes the account. An app that is down or slow says nothing about the key.
        const added = before && listing.entries.find(entry => !before.has(entry.id))
        if (added && 'kind' in added && added.kind === 'mcp' && added.catalog && (added.hasBearer || added.headerName)) {
            const service = await getDesktopRemoteMcpService(runtime)
            const receipt = await service.checkVaultCatalogHealth(added.id, added.revision, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])).catch(() => null)
            guard()
            if (receipt?.credentialRejected) {
                await vault.mutate({ operation: 'delete', id: added.id, revision: added.revision }, guard)
                const name = added.catalog.name
                throw new DesktopHttpError(400, `${name} refused this key. Check you copied the right one from ${name}, then try again.`)
            }
            if (receipt) return Response.json(await vault.list(), { headers })
        }
        return Response.json(listing, { headers })
    })
}
