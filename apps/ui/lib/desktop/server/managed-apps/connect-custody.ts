import type { Client, InStatement, Transaction } from '@libsql/client'
import { COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER, ManagedAppsError } from './client'

export type ConnectIdentity = { id: string; revision: string }

export async function assertConnectIdentity(reader: Pick<Transaction, 'execute'>, identity: ConnectIdentity) {
    const { rows } = await reader.execute({
        sql: `SELECT 1 FROM desktop_vault_mcp_servers
            WHERE id=? AND credential_revision=? AND name='composio' AND url=? AND credential_header=? AND sealed IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM desktop_managed_app_key WHERE id=1)`,
        args: [identity.id, identity.revision, COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER],
    })
    if (!rows.length) throw new ManagedAppsError(409, 'The Composio key changed. Reopen the Vault and try again.')
}

// Persist only results belonging to the same Vault credential that made the request.
// Keep network calls outside this transaction so a slow sign-in cannot block the workspace.
export async function saveConnectResult(db: Client, identity: ConnectIdentity, changes: InStatement[], signal?: AbortSignal) {
    signal?.throwIfAborted()
    const tx = await db.transaction('write')
    try {
        await assertConnectIdentity(tx, identity)
        if (changes.length) await tx.batch(changes)
        signal?.throwIfAborted()
        await tx.commit()
    } catch (error) {
        await tx.rollback().catch(() => {})
        throw error
    } finally { tx.close() }
}
