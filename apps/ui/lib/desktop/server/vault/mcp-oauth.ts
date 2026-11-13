import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { remoteMcpLifecycle } from '../mcp/lifecycle'
import { loopbackMcpOAuth } from '../mcp/oauth-loopback'
import type { OAuthJson } from '../mcp/oauth-network'
import type { BrowserOAuthWriteAdmission, OAuthTokenBundle, SettleOAuthWrite } from '../mcp/store'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'
import { withRosterWrite } from '../roster-writes'

export function vaultMcpOAuth(db: Client, crypto: DesktopSecretCrypto, workspaceId: number, assertWorkspace: () => void, json?: OAuthJson) {
    const lifecycle = remoteMcpLifecycle()
    const readEntry = async (id: string, name: string) => {
        assertWorkspace()
        const row = (await db.execute({
            sql: `SELECT s.id,s.name,s.url,s.revision,o.generation,o.sealed
                FROM desktop_vault_mcp_servers s LEFT JOIN desktop_vault_mcp_oauth o ON o.item_id=s.id
                WHERE s.id=? AND s.name=? AND s.oauth_enabled=1 AND s.sealed IS NULL`,
            args: [id, name],
        })).rows[0]
        if (!row) throw new Error('Vault browser sign-in is unavailable')
        return { id, name, url: String(row.url), revision: String(row.revision), bearer: '', generation: row.generation, sealed: row.sealed }
    }
    function context(id: string, url: string, generation: string) {
        return { domain: 'vault' as const, agentId: id, key: JSON.stringify(['mcp-oauth', url]), version: 1, workspaceId, revision: generation }
    }
    async function readOAuth(id: string, name: string): Promise<OAuthTokenBundle | null> {
        const row = await readEntry(id, name)
        if (typeof row.sealed !== 'string') return null
        const bytes = await crypto.open(context(id, row.url, String(row.generation)), String(row.sealed))
        try {
            const bundle = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')) as OAuthTokenBundle
            if (bundle.resource !== row.url) throw new Error('Vault OAuth resource changed')
            return bundle
        } finally { bytes.fill(0) }
    }
    async function browserCredentialState(id: string, name: string) {
        const row = await readEntry(id, name)
        return { registrationId: id, revision: row.revision, resource: row.url, sealed: typeof row.sealed === 'string' ? row.sealed : null }
    }
    function replaceOAuth(id: string, name: string, expected: { registrationId: string; revision: string; sealed: string | null },
        bundle: OAuthTokenBundle, signal: AbortSignal, approval?: BrowserOAuthWriteAdmission, settle?: SettleOAuthWrite) {
        if (approval || settle || expected.registrationId !== id) throw new Error('Vault OAuth authority changed')
        return lifecycle.commitCredentials(id, name, signal, check => withRosterWrite(async () => {
            check(); assertWorkspace()
            const generation = randomUUID()
            const bytes = Buffer.from(JSON.stringify(bundle), 'utf8')
            let sealed: string
            try { sealed = await crypto.seal(context(id, bundle.resource, generation), bytes) }
            finally { bytes.fill(0) }
            const tx = await db.transaction('write')
            try {
                const result = await tx.execute({
                    sql: `INSERT INTO desktop_vault_mcp_oauth(item_id,generation,sealed)
                        SELECT s.id,?,? FROM desktop_vault_mcp_servers s
                        WHERE s.id=? AND s.name=? AND s.revision=? AND s.url=? AND s.oauth_enabled=1 AND s.sealed IS NULL
                        AND (SELECT sealed FROM desktop_vault_mcp_oauth WHERE item_id=s.id) IS ?
                        ON CONFLICT(item_id) DO UPDATE SET generation=excluded.generation,sealed=excluded.sealed`,
                    args: [generation, sealed, id, name, expected.revision, bundle.resource, expected.sealed],
                })
                if (result.rowsAffected !== 1) throw new Error('Vault OAuth credential changed')
                check(); assertWorkspace()
                await tx.commit()
                return sealed
            } finally { tx.close() }
        }))
    }
    const oauth = loopbackMcpOAuth({
        lifecycle, read: readEntry, readOAuth,
        async writeOAuth(id, name, revision, bundle, signal) {
            const current = await browserCredentialState(id, name)
            if (current.revision !== revision) throw new Error('Vault OAuth server changed')
            await replaceOAuth(id, name, current, bundle, signal)
        },
    }, async () => {
        assertWorkspace()
        return { enabled: true, granted: true }
    }, json, { browserCredentialState, replaceOAuth })
    return { ...oauth, readOAuth }
}
