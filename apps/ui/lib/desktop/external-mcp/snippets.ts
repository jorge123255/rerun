import { EXTERNAL_MCP_PATH, type ExternalMcpListenerView } from '@rerun/contracts'
import type { McpClientId } from '@/lib/mcp/connect'

export const EXTERNAL_MCP_KEY_PLACEHOLDER = 'rk_your_key'
const SERVER_NAME = 'rerun'
const CODEX_KEY_ENV = 'RERUN_MCP_KEY'

export function externalMcpEndpoint(listener: ExternalMcpListenerView): string | null {
    if (!listener.enabled || !listener.origin || listener.workspaceId === null || listener.path !== EXTERNAL_MCP_PATH) return null
    try {
        const origin = new URL(listener.origin)
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== listener.origin) return null
        return `${listener.origin}${EXTERNAL_MCP_PATH}`
    } catch {
        return null
    }
}

const authorizationHeader = (key: string) => `Bearer ${key}`
export const claudeExternalMcpAddCommand = (url: string, key: string) => `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: ${authorizationHeader(key)}"`
export const externalMcpRemoteCommand = (url: string, key: string) => `npx -y mcp-remote ${url} --header "Authorization: ${authorizationHeader(key)}"`

export type ExternalMcpSnippet = { label: string; value: string; block?: boolean; hint?: string }

export function externalMcpClientSnippets(client: McpClientId, url: string, key: string): ExternalMcpSnippet[] {
    switch (client) {
        case 'claude-code':
            return [{ label: 'Terminal', value: claudeExternalMcpAddCommand(url, key) }]
        case 'chatgpt':
            return [
                { label: 'Shell profile', value: `export ${CODEX_KEY_ENV}="${key}"` },
                { label: 'Terminal', value: `codex mcp add ${SERVER_NAME} --url ${url} --bearer-token-env-var ${CODEX_KEY_ENV}`, hint: 'Codex CLI. The ChatGPT app only takes OAuth connections, so a key gets you nowhere there.' },
            ]
        case 'cursor':
            return [{ label: '~/.cursor/mcp.json', value: JSON.stringify({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: authorizationHeader(key) } } } }, null, 2), block: true }]
        case 'rerun':
            return [{
                label: 'Coworker panel, MCP, New',
                value: JSON.stringify({ name: SERVER_NAME, transport: 'http', url, headers: { Authorization: authorizationHeader(key) } }, null, 2),
                block: true,
                hint: 'Gives one of your coworkers the same reach over this workspace as an outside client.',
            }]
        case 'other':
            return [
                { label: 'Server URL', value: url },
                { label: 'Header', value: `Authorization: ${authorizationHeader(key)}` },
                { label: 'Clients that only speak stdio', value: externalMcpRemoteCommand(url, key) },
            ]
    }
}
