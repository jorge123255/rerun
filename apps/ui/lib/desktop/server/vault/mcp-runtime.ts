import 'server-only'
import type { Client } from '@libsql/client'
import { remoteMcpLifecycle } from '../mcp/lifecycle'
import type { RemoteServer } from '../mcp/model'
import { remoteMcpRuntime, type McpAccess, type McpNetwork } from '../mcp/remote'
import { remoteMcpTools } from '../mcp/tools'
import type { DesktopSecretCrypto } from '../secret-requests/crypto'
import { vaultMcpHttps } from './mcp-network'

export function desktopVaultMcpRuntime(db: Client, crypto: DesktopSecretCrypto, workspaceId: number, access: McpAccess, shutdown: AbortSignal, network: McpNetwork = vaultMcpHttps) {
    const lifecycle = remoteMcpLifecycle()
    const close = () => lifecycle.shutdown()
    shutdown.addEventListener('abort', close, { once: true })
    if (shutdown.aborted) close()

    async function assigned(agentId: string, name?: string) {
        return (await db.execute({
            sql: `SELECT s.id,s.name,s.url,s.revision,s.credential_revision,s.sealed IS NOT NULL AS has_bearer
                FROM desktop_vault_mcp_servers s JOIN desktop_agents a ON a.id=? AND a.workspace_id=1
                WHERE (? IS NULL OR s.name=?)
                AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
                AND (s.shared_with_all=1 OR EXISTS (SELECT 1 FROM desktop_vault_mcp_attachments t WHERE t.item_id=s.id AND t.agent_id=a.id))
                AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp p WHERE p.agent_id=a.id AND p.name=s.name)
                AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio p WHERE p.owner=a.id AND p.name=s.name)
                ORDER BY s.name`,
            args: [agentId, name ?? null, name ?? null],
        })).rows
    }
    function view(row: Awaited<ReturnType<typeof assigned>>[number]): RemoteServer {
        return { id: String(row.id), name: String(row.name), url: String(row.url), revision: String(row.revision), transport: 'http', hasBearer: row.has_bearer === 1 }
    }
    const store = {
        lifecycle,
        async list(agentId: string) { return (await assigned(agentId)).map(view) },
        async read(agentId: string, name: string) {
            const [row] = await assigned(agentId, name)
            if (!row) throw new Error('Vault MCP server unavailable')
            const { hasBearer, ...server } = view(row)
            if (!hasBearer) return { ...server, bearer: '' }
            const credentialRevision = String(row.credential_revision)
            const sealed = (await db.execute({
                sql: 'SELECT sealed FROM desktop_vault_mcp_servers WHERE id=? AND revision=? AND credential_revision=?',
                args: [server.id!, server.revision, credentialRevision],
            })).rows[0]?.sealed
            if (typeof sealed !== 'string') throw new Error('Vault MCP credential changed')
            const bytes = await crypto.open({ domain: 'vault', agentId: server.id!, key: server.url, version: 1, workspaceId, revision: credentialRevision }, sealed)
            try {
                return { ...server, bearer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8') }
            } finally { bytes.fill(0) }
        },
        async readOAuth() { return null },
    }
    const runtime = remoteMcpRuntime(store, access, network)
    return {
        tools: (owner: string, signal: AbortSignal) => remoteMcpTools(owner, store, runtime, AbortSignal.any([signal, shutdown])),
    }
}
