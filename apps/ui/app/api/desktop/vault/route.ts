import { desktopVaultMutation } from '@/lib/desktop/vault'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { createDesktopSecretCrypto } from '@/lib/desktop/server/secret-requests/crypto'
import { desktopVault } from '@/lib/desktop/server/vault/store'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }

const crypto = createDesktopSecretCrypto(() => {
    const key = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DesktopHttpError(503, 'Encrypted credential storage is unavailable.')
    return Buffer.from(key, 'hex')
})

async function store(runtime: DesktopRuntime) {
    return desktopVault(await openDesktopDatabase(runtime.dataRoot), crypto, runtime.workspaceId)
}

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await (await store(runtime)).list(), { headers }))
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopVaultMutation.safeParse(await readDesktopJson(request, 128 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'Enter valid Vault settings.')
        const listing = await (await store(runtime)).mutate(parsed.data, () => {
            request.signal.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
        })
        return Response.json(listing, { headers })
    })
}
