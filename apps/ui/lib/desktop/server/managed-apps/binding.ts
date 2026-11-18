import 'server-only'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { findDesktopAgent } from '../store'
import { COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER, managedAppsConnectClient } from './client'
import { COMPOSIO_CONNECT_NAME, desktopManagedApps } from './service'

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
        // The Connect key is the header credential of the Vault's “composio” server. It is opened here for the
        // one call and sent only to Composio Connect; an entry pointing anywhere else is not used.
        async connect() {
            const row = (await db.execute({ sql: 'SELECT id,url,credential_revision,sealed,credential_header FROM desktop_vault_mcp_servers WHERE name=?', args: [COMPOSIO_CONNECT_NAME] })).rows[0]
            if (!row || row.url !== COMPOSIO_CONNECT || row.credential_header !== COMPOSIO_CONNECT_HEADER || typeof row.sealed !== 'string') return null
            const opened = await crypto.open({ domain: 'vault', agentId: String(row.id), key: JSON.stringify([COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER]), version: 1, workspaceId: runtime.workspaceId, revision: String(row.credential_revision) }, row.sealed).catch(() => null)
            if (!opened) return null
            try {
                return { ...managedAppsConnectClient(Buffer.from(opened).toString('utf8')), identity: { id: String(row.id), revision: String(row.credential_revision) } }
            } finally { opened.fill(0) }
        },
    })
}
