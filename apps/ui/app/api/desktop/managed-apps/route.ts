import { desktopManagedAppsActionSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopManagedApps } from '@/lib/desktop/server/managed-apps/binding'
import { COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER, managedAppsConnectAccepts, ManagedAppsError } from '@/lib/desktop/server/managed-apps/client'
import { COMPOSIO_CONNECT_NAME } from '@/lib/desktop/server/managed-apps/service'
import { openDesktopVault } from '@/lib/desktop/server/vault/binding'
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
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)])
        const apps = await openDesktopManagedApps(runtime)
        // A Composio Connect key opens one connector that reaches every app. It belongs in the Vault as that
        // connector, with the key as its header, where it is given to coworkers like any other server.
        async function connect(key: string) {
            const vault = await openDesktopVault(runtime)
            if ((await vault.list()).entries.some(entry => entry.name === COMPOSIO_CONNECT_NAME)) throw new DesktopHttpError(409, 'Composio is already in the Vault. Open “composio” there to replace its key.')
            await vault.mutate({ operation: 'create-server', name: COMPOSIO_CONNECT_NAME, url: COMPOSIO_CONNECT, bearer: '', header: { name: COMPOSIO_CONNECT_HEADER, value: key } }, () => {
                request.signal.throwIfAborted()
                assertDesktopWorkspaceAdmission(runtime)
            })
            return Response.json({ view: await apps.view(), addedToVault: COMPOSIO_CONNECT_NAME }, { headers })
        }
        try {
            if (parsed.data.action === 'set-key' && parsed.data.key.startsWith('ck_') && await managedAppsConnectAccepts(parsed.data.key, undefined, signal)) return await connect(parsed.data.key)
            try { return Response.json(await apps.act(parsed.data, signal), { headers }) }
            catch (error) {
                // A key the platform does not know may still be a Connect key under another prefix.
                if (parsed.data.action === 'set-key' && error instanceof ManagedAppsError && (error.status === 401 || error.status === 403)
                    && await managedAppsConnectAccepts(parsed.data.key, undefined, signal).catch(() => false)) return await connect(parsed.data.key)
                throw error
            }
        } catch (error) {
            // Composio's own words may carry the key or an account detail, so only these fixed messages leave.
            if (error instanceof ManagedAppsError) throw new DesktopHttpError(error.status === 401 || error.status === 403 ? 400 : error.status === 400 || error.status === 409 ? error.status : 502, error.message)
            throw error
        }
    })
}
