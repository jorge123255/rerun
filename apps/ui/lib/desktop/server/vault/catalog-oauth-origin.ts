import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import type { OAuthTokenBundle } from '../mcp/store'
import { oauthHttps } from '../mcp/oauth-network'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'
import { openCatalogOAuthToken, sealCatalogOAuthToken } from '../services/oauth/store'
import { withRosterWrite } from '../roster-writes'

type Query = Pick<Transaction, 'execute'>
type Source = {
    owner: string
    installationId: string
    revision: string
    url: string
    methodId: string
    engineId: string
}

function nonce(ciphertext: string) {
    return createHash('sha256').update(ciphertext).digest('hex')
}

export async function readCatalogOAuthOrigin(tx: Query, key: () => Buffer, source: Source) {
    const { owner, installationId, revision, url, methodId, engineId } = source
    const row = (await tx.execute({
        sql: `SELECT t.token_generation,t.bundle,a.state FROM desktop_service_oauth_tokens t
              JOIN desktop_service_oauth_attempts a ON a.owner=t.owner AND a.installation_id=t.installation_id AND a.attempt_id=t.token_generation
              WHERE t.owner=? AND t.installation_id=? AND t.config_generation=? AND a.state IN ('checking','connected','interrupted')
              AND json_extract(a.record,'$.binding.configGeneration')=?
              AND json_extract(a.record,'$.binding.endpoint')=?
              AND json_extract(a.record,'$.binding.methodId')=?
              AND json_extract(a.record,'$.binding.engineId')=?`,
        args: [owner, installationId, revision, revision, url, methodId, engineId],
    })).rows[0]
    if (!row) return null
    const generation = String(row.token_generation), ciphertext = String(row.bundle)
    const bundle = openCatalogOAuthToken(key(), owner, installationId, revision, generation, ciphertext)
    if (row.state === 'interrupted' && !bundle.refreshPending) return null
    if (bundle.resource !== url || oauthHttps(bundle.tokenEndpoint).origin !== oauthHttps(bundle.issuer).origin ||
        !/^[\x21-\x7e]+$/.test(bundle.accessToken)) throw new Error('Catalog app sign-in identity changed')
    return { generation, ciphertext, bundle }
}

export function vaultOAuthContext(workspaceId: number, itemId: string, url: string, generation: string) {
    return { domain: 'vault' as const, agentId: itemId, key: JSON.stringify(['mcp-oauth', url]), version: 1, workspaceId, revision: generation }
}

export async function sealVaultOAuth(crypto: DesktopSecretCrypto, workspaceId: number, itemId: string, bundle: OAuthTokenBundle) {
    const generation = randomUUID()
    const bytes = Buffer.from(JSON.stringify(bundle), 'utf8')
    try {
        return { generation, sealed: await crypto.seal(vaultOAuthContext(workspaceId, itemId, bundle.resource, generation), bytes) }
    } finally { bytes.fill(0) }
}

export async function writeVaultOAuthOrigin(tx: Query, itemId: string, source: Source, origin: NonNullable<Awaited<ReturnType<typeof readCatalogOAuthOrigin>>>) {
    await tx.execute({
        sql: `INSERT INTO desktop_vault_catalog_oauth_origin(item_id,installation_id,config_generation,token_generation,source_nonce)
              VALUES(?,?,?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET token_generation=excluded.token_generation,source_nonce=excluded.source_nonce`,
        args: [itemId, source.installationId, source.revision, origin.generation, nonce(origin.ciphertext)],
    })
}

type OriginRow = { item_id: string; installation_id: string; config_generation: string; token_generation: string; source_nonce: string; owner: string; engine_id: string }
async function originRows(tx: Query, itemId?: string) {
    return (await tx.execute({
        sql: `SELECT o.*,a.owner,a.engine_id FROM desktop_vault_catalog_oauth_origin o
              JOIN desktop_vault_catalog_adoptions a ON a.installation_id=o.installation_id AND a.item_id=o.item_id
              WHERE (? IS NULL OR o.item_id=?) ORDER BY o.item_id`,
        args: [itemId ?? null, itemId ?? null],
    })).rows.map(row => ({
        item_id: String(row.item_id), installation_id: String(row.installation_id), config_generation: String(row.config_generation),
        token_generation: String(row.token_generation), source_nonce: String(row.source_nonce), owner: String(row.owner), engine_id: String(row.engine_id),
    }))
}

async function boundSource(tx: Query, row: OriginRow) {
    const current = (await tx.execute({
        sql: `SELECT s.url,s.catalog_method FROM desktop_vault_mcp_servers s
              JOIN desktop_service_installs i ON i.id=? AND i.owner=? AND i.engine_id=? AND i.revision=? AND i.state='ready'
              JOIN desktop_agents a ON a.id=i.owner AND a.engine_agent_id=i.engine_id AND a.workspace_id=1
              WHERE s.id=? AND s.oauth_enabled=1 AND s.catalog_slug=i.slug
              AND (s.shared_with_all=1 OR EXISTS(SELECT 1 FROM desktop_vault_mcp_attachments t WHERE t.item_id=s.id AND t.agent_id=a.id))
              AND json_extract(i.plan,'$.shape')='oauth' AND json_extract(i.plan,'$.url')=s.url
              AND json_extract(i.plan,'$.methodId')=s.catalog_method
              AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)`,
        args: [row.installation_id, row.owner, row.engine_id, row.config_generation, row.item_id],
    })).rows[0]
    return current ? {
        owner: row.owner, installationId: row.installation_id, engineId: row.engine_id,
        revision: row.config_generation, url: String(current.url), methodId: String(current.catalog_method),
    } : null
}

/** Mirror refresh markers as well as completed rotations so a rollback cannot replay an uncertain refresh. */
export async function mirrorVaultOAuth(tx: Query, itemId: string, key: () => Buffer, bundle: OAuthTokenBundle) {
    const [row] = await originRows(tx, itemId)
    if (!row) return
    const source = await boundSource(tx, row)
    const legacy = source && await readCatalogOAuthOrigin(tx, key, source)
    if (!source || !legacy || legacy.generation !== row.token_generation || nonce(legacy.ciphertext) !== row.source_nonce ||
        source.url !== bundle.resource) throw new Error('Catalog app sign-in changed in an earlier version of Rerun')
    const sealed = sealCatalogOAuthToken(key(), source.owner, source.installationId, source.revision, legacy.generation, bundle)
    const result = await tx.execute({
        sql: `UPDATE desktop_service_oauth_tokens SET bundle=? WHERE owner=? AND installation_id=?
              AND config_generation=? AND token_generation=? AND bundle=?`,
        args: [sealed, source.owner, source.installationId, source.revision, legacy.generation, legacy.ciphertext],
    })
    if (result.rowsAffected !== 1) throw new Error('Catalog app sign-in changed')
    await tx.execute({ sql: 'UPDATE desktop_vault_catalog_oauth_origin SET source_nonce=? WHERE item_id=?', args: [nonce(sealed), itemId] })
}

/** Remove only this lineage's original copy, never a newer or independently attached login. */
export async function retireVaultOAuthOrigin(tx: Query, itemId: string, remainAssigned?: Set<string>) {
    const [row] = await originRows(tx, itemId)
    if (!row || remainAssigned?.has(row.owner)) return
    await tx.execute({
        sql: 'DELETE FROM desktop_service_oauth_tokens WHERE owner=? AND installation_id=? AND config_generation=? AND token_generation=?',
        args: [row.owner, row.installation_id, row.config_generation, row.token_generation],
    })
    await tx.execute({ sql: 'DELETE FROM desktop_vault_catalog_oauth_origin WHERE item_id=?', args: [itemId] })
}

export async function reconcileVaultOAuthOrigins(db: Client, key: () => Buffer, crypto: DesktopSecretCrypto, workspaceId: number, assertCurrent: () => void) {
    for (const { item_id: itemId } of await originRows(db)) {
        await withRosterWrite(async () => {
            assertCurrent()
            const tx = await db.transaction('write')
            try {
                const [row] = await originRows(tx, itemId)
                if (!row) return
                const source = await boundSource(tx, row)
                const legacy = source && await readCatalogOAuthOrigin(tx, key, source).catch(() => null)
                if (legacy && nonce(legacy.ciphertext) === row.source_nonce) return
                if (source && legacy) {
                    const { generation, sealed } = await sealVaultOAuth(crypto, workspaceId, itemId, legacy.bundle)
                    await tx.execute({
                        sql: `INSERT INTO desktop_vault_mcp_oauth(item_id,generation,sealed) VALUES(?,?,?)
                              ON CONFLICT(item_id) DO UPDATE SET generation=excluded.generation,sealed=excluded.sealed`,
                        args: [itemId, generation, sealed],
                    })
                    await writeVaultOAuthOrigin(tx, itemId, source, legacy)
                } else {
                    if (source) await tx.execute({ sql: 'DELETE FROM desktop_vault_mcp_oauth WHERE item_id=?', args: [itemId] })
                    await retireVaultOAuthOrigin(tx, itemId)
                }
                await tx.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET revision=? WHERE id=?', args: [randomUUID(), itemId] })
                assertCurrent()
                await tx.commit()
            } finally { tx.close() }
        })
    }
}
