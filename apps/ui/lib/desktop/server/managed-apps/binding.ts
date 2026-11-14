import 'server-only'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { findDesktopAgent } from '../store'
import { desktopManagedApps } from './service'

const crypto = createDesktopSecretCrypto(() => {
    const key = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DesktopHttpError(503, 'Encrypted credential storage is unavailable.')
    return Buffer.from(key, 'hex')
})

export const DESKTOP_MANAGED_APPS_RETURN_PATH = '/api/desktop/managed-apps/return'

export async function openDesktopManagedApps(runtime: DesktopRuntime) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    return desktopManagedApps(db, crypto, runtime.workspaceId, {
        returnUrl: runtime.app.origin + DESKTOP_MANAGED_APPS_RETURN_PATH,
        coworkerExists: async agentId => (await findDesktopAgent(db, agentId)) !== null,
    })
}
