import 'server-only'
import type { Client } from '@libsql/client'
import type { DesktopVaultHealthReceipt } from '../../vault'
import { DesktopHttpError } from '../auth'
import { withRosterWrite } from '../roster-writes'

type Account = { id: string; name: string; revision: string; generation: string | null }

export function vaultCatalogHealth(
    db: Client,
    launchNonce: string,
    assertWorkspace: () => void,
    shutdown: AbortSignal,
    inspect: (entry: Account, signal: AbortSignal) => Promise<'signed-out' | 'expired' | { toolCount: number; credentialExpiresAt?: string }>,
) {
    let checking = false

    return async function check(id: string, revision: string, stop: AbortSignal): Promise<DesktopVaultHealthReceipt> {
        const signal = AbortSignal.any([shutdown, stop])
        const assertCurrent = () => { signal.throwIfAborted(); assertWorkspace() }
        assertCurrent()
        if (checking) throw new DesktopHttpError(409, 'A Vault connection check is already running.')
        checking = true
        try {
            const row = (await db.execute({
                sql: `SELECT s.name,s.revision,o.generation
                    FROM desktop_vault_mcp_servers s LEFT JOIN desktop_vault_mcp_oauth o ON o.item_id=s.id
                    WHERE s.id=? AND s.catalog_slug IS NOT NULL`,
                args: [id],
            })).rows[0]
            if (!row || row.revision !== revision) throw new DesktopHttpError(409, 'This Vault entry changed. Reopen it and try again.')
            const generation = typeof row.generation === 'string' ? row.generation : null
            const account = { id, name: String(row.name), revision, generation }
            const observed = await inspect(account, signal).catch(() => 'failed' as const)
            assertCurrent()
            const checkedAt = new Date().toISOString()
            let health: DesktopVaultHealthReceipt
            if (observed === 'signed-out') {
                health = { state: 'disconnected', checkedAt, message: 'Sign in to this account before checking its connection.' }
            } else if (observed === 'expired') {
                health = { state: 'error', checkedAt, message: 'The saved sign-in expired. Reconnect to check this account.' }
            } else if (observed === 'failed') {
                health = { state: 'error', checkedAt, message: 'The app did not respond to the connection check.' }
            } else {
                health = { state: 'healthy', checkedAt, ...observed }
            }

            await withRosterWrite(async () => {
                assertCurrent()
                const tx = await db.transaction('write')
                try {
                    const result = await tx.execute({
                        sql: `INSERT INTO desktop_vault_catalog_health(item_id,revision,oauth_generation,launch_nonce,receipt)
                            SELECT s.id,s.revision,o.generation,?,? FROM desktop_vault_mcp_servers s
                            LEFT JOIN desktop_vault_mcp_oauth o ON o.item_id=s.id
                            WHERE s.id=? AND s.catalog_slug IS NOT NULL AND s.revision=? AND o.generation IS ?
                            ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision,oauth_generation=excluded.oauth_generation,
                                launch_nonce=excluded.launch_nonce,receipt=excluded.receipt`,
                        args: [launchNonce, JSON.stringify(health), id, revision, generation],
                    })
                    if (result.rowsAffected !== 1) throw new DesktopHttpError(409, 'This Vault entry changed during the check. Try again.')
                    assertCurrent()
                    await tx.commit()
                } finally { tx.close() }
            })
            return health
        } finally { checking = false }
    }
}
