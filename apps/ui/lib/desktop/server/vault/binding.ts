import 'server-only'
import { DesktopHttpError } from '../auth'
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
    return desktopVault(await openDesktopDatabase(runtime.dataRoot), crypto, runtime.workspaceId)
}
