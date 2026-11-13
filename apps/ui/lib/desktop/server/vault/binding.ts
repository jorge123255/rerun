import 'server-only'
import { DesktopHttpError } from '../auth'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { desktopVault } from './store'

const crypto = createDesktopSecretCrypto(() => {
    const key = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DesktopHttpError(503, 'Encrypted credential storage is unavailable.')
    return Buffer.from(key, 'hex')
})

export async function openDesktopVault(runtime: DesktopRuntime) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    // Vault can be the first app surface opened after an upgrade.
    const { rows } = await db.execute('SELECT 1 FROM desktop_service_installs LIMIT 1')
    if (rows.length) await getDesktopRemoteMcpService(runtime)
    return desktopVault(db, crypto, runtime.workspaceId, runtime.launchNonce)
}
