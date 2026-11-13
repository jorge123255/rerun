import 'server-only'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { newServiceInstanceId } from '@/lib/services/instances'
import { withRosterWrite } from '../roster-writes'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { openStoredHeaderBundle } from '../services/accounts/header-secret-codec'
import type { AccountCompilePlan } from '../services/accounts/compiler'
import { compileCatalogOAuth } from '../services/oauth/compiler'
import { getDesktopServiceManifest } from '../services/catalog'
import { serviceStore, type ServiceInstall } from '../services/store'
import { compileVaultCatalogApp, vaultCatalogAllowsInstances } from './catalog'
import { readCatalogOAuthOrigin, reconcileVaultOAuthOrigins, sealVaultOAuth, writeVaultOAuthOrigin } from './catalog-oauth-origin'

type Connection = ReturnType<typeof compileVaultCatalogApp>

function context(workspaceId: number, id: string, url: string, revision: string, header: string | null) {
    return { domain: 'vault' as const, version: 1, workspaceId, agentId: id,
        key: header ? JSON.stringify([url, header]) : url, revision }
}

async function readFields(tx: Transaction, record: ServiceInstall, key: () => Buffer, readBearer: () => string) {
    const plan = record.plan as ServiceInstall['plan'] & Partial<AccountCompilePlan>
    if (plan.transport === 'sse' || plan.shape === 'oauth') return null
    const { rows } = await tx.execute({
        sql: 'SELECT revision,bundle FROM desktop_service_header_secrets WHERE owner=? AND installation_id=?',
        args: [record.owner, record.id],
    })
    if (rows.length) {
        if (rows[0].revision !== record.revision || typeof rows[0].bundle !== 'string') return null
        const bundle = openStoredHeaderBundle(key(), record.owner, record.id, record.revision, rows[0].bundle)
        return { values: { ...plan.publicInputs, ...bundle.inputs }, headers: bundle.headers }
    }
    if (record.configured && !plan.shape && plan.secretInput) {
        const bearer = readBearer()
        return { values: { [plan.secretInput]: bearer }, headers: { Authorization: 'Bearer ' + bearer } }
    }
    if (record.configured || (plan.shape && plan.shape !== 'anonymous') || plan.secretInput) return null
    return { values: {}, headers: {} }
}

function sameHeaders(fields: Record<string, string>, connection: Connection) {
    const entries = Object.entries(fields)
    if (!connection.header && !connection.bearer) return entries.length === 0
    const header = connection.header?.name ?? 'Authorization'
    const value = connection.header?.value ?? 'Bearer ' + connection.bearer
    return entries.length === 1 && entries[0][0].toLowerCase() === header.toLowerCase() && entries[0][1] === value
}

const candidatesSql = `
    SELECT s.owner,s.engine_id,s.key,s.id,s.revision FROM desktop_service_installs s
        JOIN desktop_agents a ON a.id=s.owner AND a.engine_agent_id=s.engine_id AND a.workspace_id=1
        WHERE s.state='ready' AND json_valid(s.plan)
        AND NOT EXISTS(SELECT 1 FROM desktop_vault_catalog_adoptions x WHERE x.installation_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
        ORDER BY s.installed_at,s.id LIMIT 4096`

/** Keep the original encrypted record and its skill journal for older builds.
 * The receipt fences the old tool path even after detach or deletion. */
export async function adoptDesktopCatalogApps(input: {
    db: Client
    workspaceId: number
    key: () => Buffer
    assertCurrent: () => void
    verifySkills: (record: ServiceInstall) => Promise<() => void>
}) {
    const { db, workspaceId, key, assertCurrent, verifySkills } = input
    const source = serviceStore(db, key, true)
    const crypto = createDesktopSecretCrypto(key)
    await reconcileVaultOAuthOrigins(db, key, crypto, workspaceId, assertCurrent)
    const candidates = (await db.execute(candidatesSql)).rows
    let adopted = 0
    for (const candidate of candidates) {
        assertCurrent()
        const record = await source.read(String(candidate.owner), String(candidate.key)).catch(() => null)
        if (!record || record.id !== candidate.id || record.revision !== candidate.revision) continue
        const checkOwner = await verifySkills(record).catch(() => null)
        if (!checkOwner) { assertCurrent(); continue }
        const result = await withRosterWrite(async () => {
            assertCurrent()
            try { checkOwner() } catch { return false }
            const tx = await db.transaction('write')
            try {
                const current = (await tx.execute({
                    sql: `SELECT s.bearer,a.name,s.plan,s.skills FROM desktop_service_installs s
                        JOIN desktop_agents a ON a.id=s.owner AND a.engine_agent_id=s.engine_id AND a.workspace_id=1
                        WHERE s.id=? AND s.owner=? AND s.engine_id=? AND s.revision=? AND s.state='ready'
                        AND NOT EXISTS(SELECT 1 FROM desktop_vault_catalog_adoptions x WHERE x.installation_id=s.id)
                        AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)`,
                    args: [record.id, record.owner, record.engineId, record.revision],
                })).rows[0]
                if (!current || JSON.stringify(record.plan) !== current.plan || JSON.stringify(record.skills) !== current.skills) return false
                const plan = record.plan as ServiceInstall['plan'] & Partial<AccountCompilePlan>
                let connection: Connection | undefined
                const isOAuth = plan.shape === 'oauth'
                const originSource = { owner: record.owner, installationId: record.id, revision: record.revision,
                    engineId: record.engineId, url: plan.url, methodId: plan.methodId }
                let origin: Awaited<ReturnType<typeof readCatalogOAuthOrigin>> = null
                let values: Record<string, string>
                try {
                    if (isOAuth) {
                        const declared = compileCatalogOAuth(getDesktopServiceManifest(plan.slug).manifest, plan.methodId)
                        if (plan.oauthFingerprint !== declared.fingerprint || plan.url !== declared.endpoint) return false
                        origin = await readCatalogOAuthOrigin(tx, key, originSource)
                        if (!origin) return false
                        values = {}
                    } else {
                        const fields = await readFields(tx, record, key, () => source.openBearer(record.owner, record.id, String(current.bearer)))
                        if (!fields) return false
                        values = fields.values
                        connection = compileVaultCatalogApp(plan.slug, plan.methodId, values, plan.instanceId)
                        if (!sameHeaders(fields.headers, connection)) return false
                    }
                    connection ??= compileVaultCatalogApp(plan.slug, plan.methodId, values, plan.instanceId)
                    if (Boolean(connection.browserSignIn) !== isOAuth || connection.name !== plan.serverName || connection.url !== plan.url) return false
                } catch { return false }

                const accounts = (await tx.execute({
                    sql: `SELECT s.*, EXISTS(SELECT 1 FROM desktop_vault_mcp_attachments a
                          WHERE a.item_id=s.id AND a.agent_id=?) AS attached
                          FROM desktop_vault_mcp_servers s WHERE s.catalog_slug=? ORDER BY s.name`,
                    args: [record.owner, plan.slug],
                })).rows
                let itemId: string | undefined
                const secret = connection.header?.value ?? (connection.bearer || null)
                const header = connection.header?.name ?? null
                for (const account of accounts) {
                    if (isOAuth) break
                    if (account.name !== connection.name || account.url !== connection.url || account.catalog_method !== plan.methodId ||
                        account.oauth_enabled !== 0 || account.credential_header !== header || account.shared_with_all !== 0 || account.attached !== 0) continue
                    const linked = (await tx.execute({
                        sql: 'SELECT 1 FROM desktop_vault_catalog_adoptions WHERE item_id=? AND item_revision=? AND owner!=? LIMIT 1',
                        args: [String(account.id), String(account.revision), record.owner],
                    })).rows.length
                    if (!linked) continue
                    if (account.sealed === null && secret === null) itemId = String(account.id)
                    else if (typeof account.sealed === 'string' && secret !== null) {
                        const bytes = await crypto.open(context(workspaceId, String(account.id), connection.url, String(account.credential_revision), header), account.sealed).catch(() => null)
                        const candidate = Buffer.from(secret)
                        try {
                            if (bytes?.length === candidate.length && timingSafeEqual(bytes, candidate)) itemId = String(account.id)
                        } finally { bytes?.fill(0); candidate.fill(0) }
                    }
                    if (itemId) break
                }
                let instanceId = plan.instanceId
                if (!itemId && accounts.length && !vaultCatalogAllowsInstances(plan.slug)) return false
                const serverName = connection.name
                if (!itemId && accounts.some(account => account.name === serverName)) {
                    instanceId = newServiceInstanceId(accounts.map(account => String(account.catalog_instance ?? '')))
                    connection = compileVaultCatalogApp(plan.slug, plan.methodId, values, instanceId)
                }
                const collision = (await tx.execute({
                    sql: `SELECT 1 FROM desktop_remote_mcp WHERE agent_id=? AND name=?
                          UNION ALL SELECT 1 FROM desktop_mcp_stdio WHERE owner=? AND name=?
                          UNION ALL SELECT 1 FROM desktop_service_installs WHERE owner=? AND id!=? AND json_extract(plan,'$.serverName')=?
                          UNION ALL SELECT 1 FROM desktop_vault_mcp_programs WHERE name=?
                          UNION ALL SELECT 1 FROM desktop_vault_mcp_servers WHERE id IS NOT ? AND name=? LIMIT 1`,
                    args: [record.owner, connection.name, record.owner, connection.name, record.owner, record.id, connection.name,
                        connection.name, itemId ?? null, connection.name],
                })).rows.length
                if (collision) return false
                const revision = randomUUID()
                if (itemId) {
                    const count = await tx.execute({ sql: 'SELECT count(*) AS total FROM desktop_vault_mcp_attachments WHERE item_id=?', args: [itemId] })
                    if (Number(count.rows[0]?.total) >= 250) return false
                    await tx.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET revision=?,catalog_label=NULL WHERE id=?', args: [revision, itemId] })
                } else {
                    itemId = randomUUID()
                    const bytes = secret === null ? null : Buffer.from(secret)
                    let sealed: string | null = null
                    try {
                        if (bytes) sealed = await crypto.seal(context(workspaceId, itemId, connection.url, revision, header), bytes)
                    } finally { bytes?.fill(0) }
                    const label = String(plan.label && plan.label !== plan.name ? plan.label : current.name)
                        .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || connection.displayName
                    const names = new Set(accounts.map(account => String(account.catalog_label ?? account.catalog_name).toLowerCase()))
                    let display = label
                    for (let ordinal = 2; names.has(display.toLowerCase()); ordinal++) display = label.slice(0, 110) + ' ' + ordinal
                    await tx.execute({
                        sql: `INSERT INTO desktop_vault_mcp_servers(id,name,url,revision,credential_revision,sealed,credential_header,oauth_enabled,
                              catalog_slug,catalog_method,catalog_name,catalog_instance,catalog_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        args: [itemId, connection.name, connection.url, revision, revision, sealed, header, Number(isOAuth),
                            plan.slug, plan.methodId, connection.displayName, instanceId ?? null, display],
                    })
                }
                await tx.execute({ sql: 'INSERT INTO desktop_vault_mcp_attachments(item_id,agent_id) VALUES(?,?)', args: [itemId, record.owner] })
                await tx.execute({
                    sql: 'INSERT INTO desktop_vault_catalog_adoptions(installation_id,owner,engine_id,item_id,item_revision) VALUES(?,?,?,?,?)',
                    args: [record.id, record.owner, record.engineId, itemId, revision],
                })
                if (origin) {
                    const { generation, sealed } = await sealVaultOAuth(crypto, workspaceId, itemId, origin.bundle)
                    await tx.execute({ sql: 'INSERT INTO desktop_vault_mcp_oauth(item_id,generation,sealed) VALUES(?,?,?)',
                        args: [itemId, generation, sealed] })
                    await writeVaultOAuthOrigin(tx, itemId, originSource, origin)
                }
                assertCurrent()
                try { checkOwner() } catch { return false }
                await tx.commit()
                return true
            } finally { tx.close() }
        })
        adopted += Number(result)
    }
    return adopted
}
