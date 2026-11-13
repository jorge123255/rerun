import 'server-only'
import { redactDesktopMcpSecretValue, type DesktopMcpSseRef } from '@rerun/contracts'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { McpRunIdentity } from '../mcp/bridge'
import { bindDesktopSseRuntime, sseInvocationId, type DesktopSseRuntimeDeps } from '../mcp-sse/binding'
import { sseToolDefinitions } from '../mcp-sse/adapters'
import { SseFailure } from '../mcp-sse/errors'
import { remoteMcpLifecycle } from '../mcp/lifecycle'
import type { RemoteServer } from '../mcp/model'
import { remoteMcpRuntime, type McpAccess, type McpNetwork } from '../mcp/remote'
import { emptyMcpMaterialLease, type DesktopMcpMaterialSource } from '../mcp-secret-references/lease'
import { remoteMcpTools } from '../mcp/tools'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'
import type { OAuthJson } from '../mcp/oauth-network'
import { vaultCatalogHealth } from './catalog-health'
import { vaultMcpOAuth } from './mcp-oauth'
import { vaultMcpHttps } from './mcp-network'

type VaultSseOptions = Pick<DesktopSseRuntimeDeps, 'store' | 'key' | 'authorizeRun' | 'network'> & {
    remoteAccess: McpAccess
    watchOwner(owner: string): () => void
}

const sseServerId = (id: string) => 'vault-' + id
const probeOwner = (id: string) => 'vault-health-' + id
type VaultRow = Awaited<ReturnType<Client['execute']>>['rows'][number]

function sseReference(owner: string, row: VaultRow): DesktopMcpSseRef {
    return { agentId: owner, serverId: sseServerId(String(row.id)), name: String(row.name), expectedRevision: String(row.revision) }
}

export function desktopVaultMcpRuntime(db: Client, crypto: DesktopSecretCrypto, workspaceId: number, access: McpAccess, shutdown: AbortSignal, network: McpNetwork = vaultMcpHttps, assertWorkspace = () => {}, oauthJson?: OAuthJson, mode: 'mcp' | 'catalog' = 'mcp', sharedOAuth?: ReturnType<typeof vaultMcpOAuth>, verifySkills?: (owner: string, itemId: string, signal: AbortSignal) => Promise<void>, sseOptions?: VaultSseOptions) {
    const lifecycle = remoteMcpLifecycle()
    const oauth = sharedOAuth ?? vaultMcpOAuth(db, crypto, workspaceId, assertWorkspace, oauthJson)
    const close = () => { if (!sharedOAuth) oauth.shutdown(); lifecycle.shutdown() }
    shutdown.addEventListener('abort', close, { once: true })
    if (shutdown.aborted) close()

    async function assigned(agentId: string, name?: string) {
        return (await db.execute({
            sql: `SELECT s.id,s.name,s.url,s.revision,s.credential_revision,s.credential_header,s.oauth_enabled,s.transport,s.sealed IS NOT NULL AS has_credential
                FROM desktop_vault_mcp_servers s JOIN desktop_agents a ON a.id=? AND a.workspace_id=1
                WHERE (? IS NULL OR s.name=?) AND (s.catalog_slug IS NOT NULL)=?
                AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
                AND (s.shared_with_all=1 OR EXISTS (SELECT 1 FROM desktop_vault_mcp_attachments t WHERE t.item_id=s.id AND t.agent_id=a.id))
                AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp p WHERE p.agent_id=a.id AND p.name=s.name)
                AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio p WHERE p.owner=a.id AND p.name=s.name)
                ${mode === 'catalog' ? `AND NOT EXISTS (
                    SELECT 1 FROM desktop_service_installs p WHERE p.owner=a.id AND json_extract(p.plan,'$.serverName')=s.name
                    AND NOT EXISTS (SELECT 1 FROM desktop_vault_catalog_adoptions x WHERE x.installation_id=p.id)
                )` : ''}
                ORDER BY s.name`,
            args: [agentId, name ?? null, name ?? null, Number(mode === 'catalog')],
        })).rows
    }
    function view(row: Awaited<ReturnType<typeof assigned>>[number]): RemoteServer {
        return { id: String(row.id), name: String(row.name), url: String(row.url), revision: String(row.revision), transport: row.transport === 'sse' ? 'sse' : 'http', hasBearer: row.has_credential === 1 && row.credential_header === null }
    }
    const store = {
        lifecycle,
        async list(agentId: string) { return (await assigned(agentId)).map(view) },
        async read(agentId: string, name: string) {
            const [row] = await assigned(agentId, name)
            if (!row) throw new Error('Vault MCP server unavailable')
            return { ...view(row), bearer: '' }
        },
        async readOAuth() { return null },
    }
    const material: DesktopMcpMaterialSource = (owner, name, revision, _phase, signal) =>
        credentials(async () => {
            signal.throwIfAborted(); assertWorkspace()
            const permission = await access(owner)
            const [row] = await assigned(owner, name)
            signal.throwIfAborted()
            if (!permission.enabled || !permission.granted || row?.revision !== revision) throw new Error('Vault MCP authority changed')
            await verifySkills?.(owner, String(row.id), signal)
            signal.throwIfAborted(); assertWorkspace()
            return row
        }, signal, true)

    async function credentials(check: () => Promise<Awaited<ReturnType<typeof assigned>>[number]>, signal: AbortSignal, refresh: boolean) {
        const row = await check()
        const { id, name, url, revision } = view(row)
        if (row.oauth_enabled === 1) {
            const token = refresh ? await oauth.credential(id!, name, revision, signal) : (await oauth.readOAuth(id!, name))?.accessToken
            if (!token) throw new Error('Sign in to this MCP server in the Vault')
            const lease = emptyMcpMaterialLease()
            const bytes = new TextEncoder().encode(token)
            lease.material.headers.Authorization = `Bearer ${token}`
            lease.check = async () => {
                await check()
                const current = await oauth.readOAuth(id!, name)
                if (current?.accessToken !== token || current.refreshPending || current.expiresAt <= Date.now()) throw new Error('Vault OAuth credential changed')
                await check()
            }
            lease.protect = result => redactDesktopMcpSecretValue(result, [bytes])
            lease.release = async () => { bytes.fill(0); delete lease.material.headers.Authorization }
            try { await lease.check(); return lease }
            catch (error) { await lease.release(); throw error }
        }
        if (row.has_credential !== 1) return emptyMcpMaterialLease()
        const credentialRevision = String(row.credential_revision)
        const header = typeof row.credential_header === 'string' ? row.credential_header : null
        const sealed = (await db.execute({
            sql: 'SELECT sealed FROM desktop_vault_mcp_servers WHERE id=? AND revision=? AND credential_revision=? AND credential_header IS ?',
            args: [id!, revision, credentialRevision, header],
        })).rows[0]?.sealed
        if (typeof sealed !== 'string') throw new Error('Vault MCP credential changed')
        const bytes = await crypto.open({ domain: 'vault', agentId: id!, key: header ? JSON.stringify([url, header]) : url, version: 1, workspaceId, revision: credentialRevision }, sealed)
        try {
            await check()
            const value = new TextDecoder().decode(bytes)
            const lease = emptyMcpMaterialLease()
            lease.configured = true
            const headers = lease.material.headers
            const name = header ?? 'Authorization'
            headers[name] = header ? value : `Bearer ${value}`
            lease.check = async () => { await check() }
            lease.protect = result => redactDesktopMcpSecretValue(result, [bytes])
            lease.release = async () => { bytes.fill(0); delete headers[name] }
            return lease
        } catch (error) {
            bytes.fill(0)
            throw error
        }
    }
    async function catalogRow(account: { id: string; name: string; revision: string; generation: string | null }, signal: AbortSignal) {
        assertWorkspace()
        signal.throwIfAborted()
        const row = (await db.execute({
            sql: `SELECT s.id,s.name,s.url,s.revision,s.credential_revision,s.credential_header,s.oauth_enabled,s.transport,
                s.sealed IS NOT NULL AS has_credential,o.generation
                FROM desktop_vault_mcp_servers s LEFT JOIN desktop_vault_mcp_oauth o ON o.item_id=s.id
                WHERE s.id=? AND s.name=? AND s.revision=? AND s.catalog_slug IS NOT NULL AND o.generation IS ?`,
            args: [account.id, account.name, account.revision, account.generation],
        })).rows[0]
        signal.throwIfAborted()
        assertWorkspace()
        if (!row) throw new Error('Vault app changed')
        return row
    }

    const sse = mode === 'catalog' && sseOptions && bindDesktopSseRuntime({
        ...sseOptions, db, shutdownSignal: shutdown, access,
        async account(ref, action, run, signal) {
            if (!ref.serverId.startsWith('vault-') || (action !== 'use' && action !== 'call')) throw new SseFailure('changed')
            const id = ref.serverId.slice('vault-'.length)
            const probe = ref.agentId === probeOwner(id)
            if (probe ? !!run || action !== 'use' : action === 'call' && !run) throw new SseFailure('changed')
            const checkOwner = probe ? undefined : sseOptions.watchOwner(ref.agentId)
            const check = () => { assertWorkspace(); shutdown.throwIfAborted(); checkOwner?.() }
            const current = async () => {
                check()
                signal.throwIfAborted()
                let row: VaultRow | undefined
                if (probe) row = await catalogRow({ id, name: ref.name, revision: ref.expectedRevision, generation: null }, signal)
                else {
                    if (run && await sseOptions.authorizeRun(run, signal) !== ref.agentId) throw new SseFailure('changed')
                    const [app, remote] = await Promise.all([access(ref.agentId), sseOptions.remoteAccess(ref.agentId)])
                    if (!app.enabled || !app.granted || !remote.enabled || !remote.granted) throw new SseFailure('changed')
                    row = (await assigned(ref.agentId, ref.name))[0]
                }
                if (!row || row.id !== id || row.revision !== ref.expectedRevision || row.transport !== 'sse'
                    || row.oauth_enabled !== 0 || row.credential_header !== null) throw new SseFailure('changed')
                signal.throwIfAborted()
                check()
                return row
            }
            const row = await current()
            if (!probe) await verifySkills?.(ref.agentId, id, signal)
            const lease = await credentials(current, signal, false)
            try {
                const value = lease.material.headers.Authorization
                if (row.has_credential === 1 && !value?.startsWith('Bearer ')) throw new SseFailure('auth-needed')
                signal.throwIfAborted()
                check()
                return { server: { ...view(row), id: ref.serverId, transport: 'sse' }, bearer: value?.slice(7) ?? '',
                    credentialGeneration: String(row.credential_revision), check }
            } finally { await lease.release() }
        },
    })
    const runtime = remoteMcpRuntime(store, access, network, undefined, material)
    return {
        oauth,
        releaseSseRun: async (owner: string, run: McpRunIdentity) => { if (sse) await sse.runtime.releaseRun(owner, run) },
        disposeSseOwner: async (owner: string) => { if (sse) await sse.dispose(owner) },
        shutdownSse: async () => { if (sse) await sse.shutdown() },
        async sseTools(owner: string, run: McpRunIdentity, signal: AbortSignal) {
            if (!sse || !sseOptions) return []
            const rows = (await assigned(owner)).filter(row => row.transport === 'sse')
            if (!rows.length) return []
            const [app, remote] = await Promise.all([access(owner), sseOptions.remoteAccess(owner)])
            if (!app.enabled || !app.granted || !remote.enabled || !remote.granted) return []
            const active = AbortSignal.any([signal, shutdown])
            const definitions = []
            for (const row of rows) {
                const ref = sseReference(owner, row)
                // An unavailable account must not hide unrelated tools in this coworker's chat.
                const tools = await sseToolDefinitions(sse.runtime, ref, run, active).catch(error => {
                    active.throwIfAborted()
                    if (error instanceof SseFailure && ['auth-needed', 'unsupported', 'unavailable', 'invalid-data', 'timeout'].includes(error.code)) return []
                    throw error
                })
                for (const tool of tools) definitions.push({
                    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
                    execute: (args: Record<string, unknown>, stop: AbortSignal, toolCallId: string) =>
                        tool.execute(args, { requestId: sseInvocationId(owner, ref, run, toolCallId), toolCallId }, stop),
                })
            }
            return definitions
        },
        catalogHealth(launchNonce: string) {
            return vaultCatalogHealth(db, launchNonce, assertWorkspace, shutdown, async (account, signal) => {
                const check = () => catalogRow(account, signal)
                const row = await check()
                if (row.transport === 'sse') {
                    if (!sse) throw new Error('Vault SSE is unavailable')
                    const result = await sse.runtime.probe({
                        ...sseReference(probeOwner(account.id), row), requestId: randomUUID(), operation: 'probe',
                    }, signal)
                    return { toolCount: result.tools.length }
                }
                let credentialExpiresAt: string | undefined
                if (row.oauth_enabled === 1) {
                    const token = await oauth.readOAuth(account.id, account.name)
                    if (!token) return 'signed-out'
                    if (token.refreshPending || token.expiresAt <= Date.now()) return 'expired'
                    credentialExpiresAt = new Date(token.expiresAt).toISOString()
                }
                // The workspace owner explicitly checks one saved account. No coworker is
                // assigned and the probe only initializes the connection and lists tools.
                const probeStore = {
                    lifecycle,
                    async read() { return { ...view(await check()), bearer: '' } },
                    async readOAuth() { return null },
                }
                const probeRuntime = remoteMcpRuntime(probeStore, async () => ({ enabled: true, granted: true }), network, undefined,
                    (_owner, _name, _revision, _phase, active) => credentials(check, active, false))
                const result = await probeRuntime.probe(account.id, account.name, account.revision, signal)
                if (!result.tools) throw new Error('Vault app did not return its tools')
                return { toolCount: result.tools.length, ...(credentialExpiresAt && { credentialExpiresAt }) }
            })
        },
        tools(owner: string, signal: AbortSignal, authorizeRun?: (signal: AbortSignal) => Promise<void>) {
            const active = AbortSignal.any([signal, shutdown])
            if (!authorizeRun) return remoteMcpTools(owner, store, runtime, active)
            const guardedNetwork: McpNetwork = (input, init, guard) => network(input, init, async () => {
                await authorizeRun(init.signal)
                await guard()
            })
            const scopedMaterial: DesktopMcpMaterialSource = async (owner, name, revision, phase, signal) => {
                await authorizeRun(signal)
                return material(owner, name, revision, phase, signal)
            }
            const scopedRuntime = remoteMcpRuntime(store, access, guardedNetwork, undefined, scopedMaterial)
            return remoteMcpTools(owner, store, scopedRuntime, active)
        },
    }
}
