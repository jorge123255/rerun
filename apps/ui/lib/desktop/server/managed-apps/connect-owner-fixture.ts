import type { Client } from '@libsql/client'
import { COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER } from './client'

/** The owner fields used by a real Vault credential, in a disposable managed-app fixture. */
export async function seedConnectCredential(db: Client) {
    const identity = { id: 'fixture-vault-entry', revision: 'fixture-revision' }
    await db.execute('CREATE TABLE IF NOT EXISTS desktop_vault_mcp_servers (id TEXT PRIMARY KEY, name TEXT, url TEXT, credential_header TEXT, credential_revision TEXT, sealed TEXT)')
    await db.execute({ sql: 'INSERT OR IGNORE INTO desktop_vault_mcp_servers VALUES (?,?,?,?,?,?)', args: [identity.id, 'composio', COMPOSIO_CONNECT, COMPOSIO_CONNECT_HEADER, identity.revision, 'fixture'] })
    return identity
}
