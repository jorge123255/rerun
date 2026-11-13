import 'server-only'
import { redactDesktopMcpSecretValue } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { remoteMcpLifecycle } from '../mcp/lifecycle'
import type { RemoteServer } from '../mcp/model'
import { remoteMcpRuntime, type McpAccess, type McpNetwork } from '../mcp/remote'
import { emptyMcpMaterialLease, type DesktopMcpMaterialSource } from '../mcp-secret-references/lease'
import { remoteMcpTools } from '../mcp/tools'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'
import type { OAuthJson } from '../mcp/oauth-network'
import { vaultMcpOAuth } from './mcp-oauth'
import { vaultMcpHttps } from './mcp-network'

export function desktopVaultMcpRuntime(db: Client, crypto: DesktopSecretCrypto, workspaceId: number, access: McpAccess, shutdown: AbortSignal, network: McpNetwork = vaultMcpHttps, assertWorkspace = () => {}, oauthJson?: OAuthJson, mode: 'mcp' | 'catalog' = 'mcp') {
    const lifecycle = remoteMcpLifecycle()
    const oauth = vaultMcpOAuth(db, crypto, workspaceId, assertWorkspace, oauthJson)
    const close = () => { oauth.shutdown(); lifecycle.shutdown() }
    shutdown.addEventListener('abort', close, { once: true })
    if (shutdown.aborted) close()

    async function assigned(agentId: string, name?: string) {
        return (await db.execute({
            sql: `SELECT s.id,s.name,s.url,s.revision,s.credential_revision,s.credential_header,s.oauth_enabled,s.sealed IS NOT NULL AS has_credential
                FROM desktop_vault_mcp_servers s JOIN desktop_agents a ON a.id=? AND a.workspace_id=1
                WHERE (? IS NULL OR s.name=?) AND (s.catalog_slug IS NOT NULL)=?
                AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
                AND (s.shared_with_all=1 OR EXISTS (SELECT 1 FROM desktop_vault_mcp_attachments t WHERE t.item_id=s.id AND t.agent_id=a.id))
                AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp p WHERE p.agent_id=a.id AND p.name=s.name)
                AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio p WHERE p.owner=a.id AND p.name=s.name)
                ${mode === 'catalog' ? `AND NOT EXISTS (
                    SELECT 1 FROM desktop_service_installs p WHERE p.owner=a.id AND json_extract(p.plan,'$.serverName')=s.name
                )` : ''}
                ORDER BY s.name`,
            args: [agentId, name ?? null, name ?? null, Number(mode === 'catalog')],
        })).rows
    }
    function view(row: Awaited<ReturnType<typeof assigned>>[number]): RemoteServer {
        return { id: String(row.id), name: String(row.name), url: String(row.url), revision: String(row.revision), transport: 'http', hasBearer: row.has_credential === 1 && row.credential_header === null }
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
    const material: DesktopMcpMaterialSource = async (owner, name, revision, _phase, signal) => {
        const check = async () => {
            signal.throwIfAborted(); assertWorkspace()
            const permission = await access(owner)
            const [row] = await assigned(owner, name)
            signal.throwIfAborted()
            if (!permission.enabled || !permission.granted || row?.revision !== revision) throw new Error('Vault MCP authority changed')
            return row
        }
        const row = await check()
        const { id, url } = view(row)
        if (row.oauth_enabled === 1) {
            const token = await oauth.credential(id!, name, revision, signal)
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
    const runtime = remoteMcpRuntime(store, access, network, undefined, material)
    return {
        oauth,
        tools(owner: string, signal: AbortSignal, authorizeRun?: (signal: AbortSignal) => Promise<void>) {
            const active = AbortSignal.any([signal, shutdown])
            if (!authorizeRun) return remoteMcpTools(owner, store, runtime, active)
            const guardedNetwork: McpNetwork = (input, init, guard) => network(input, init, async () => {
                await authorizeRun(init.signal)
                await guard()
            })
            const scopedRuntime = remoteMcpRuntime(store, access, guardedNetwork, undefined, material)
            return remoteMcpTools(owner, store, scopedRuntime, active)
        },
    }
}
