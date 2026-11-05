import 'server-only'

import type { AuthMethod, McpServerTemplate, ServiceManifest } from '@/lib/services/manifest'
import type { DesktopServiceMethodAvailability } from '../../../../../../../packages/contracts/src/desktop-services.ts'

// Policy over the normalized manifest (apps/ui/lib/services/manifest.ts).
// Hosted getMethod falls back to the default method; this classifier never does.
export const DESKTOP_METHOD_REASONS = {
    managed: 'managed OAuth is not a local desktop method',
    composio: 'Composio auth is not a local desktop method',
    app: 'paid app auth is not a local desktop method',
    oauth: 'OAuth is not a local desktop method',
    stdio: 'stdio transport is not a local desktop method',
    sse: 'SSE transport is not a local desktop method',
    serverCount: 'desktop install accepts exactly one MCP server',
    transport: 'desktop install accepts only explicit HTTPS Streamable HTTP',
    secretUrl: 'secret in URL is not a local desktop method',
    url: 'server URL is not a canonical HTTPS URL',
    env: 'env or envKeys are not a local desktop method',
    args: 'command arguments are not a local desktop method',
    skill: 'usage skill embeds a credential template',
    customHeader: 'custom headers are not an exact Authorization Bearer input',
    bearer: 'not an exact Authorization Bearer input',
} as const

const BEARER_VALUE = /^Bearer \$\{input\.([A-Za-z0-9_]+)\}$/
const TEMPLATE = /\$\{/

function unsupported(id: string, reason: (typeof DESKTOP_METHOD_REASONS)[keyof typeof DESKTOP_METHOD_REASONS]): DesktopServiceMethodAvailability {
    return { id, supported: false, reason }
}

function declaresOAuth(server: McpServerTemplate): boolean {
    // `oauth: {}` still declares browser OAuth. A missing property does not.
    return server.oauth !== undefined
}

function declaresStdio(server: McpServerTemplate): boolean {
    return server.transport === 'stdio' || (server.command !== undefined && server.command.length > 0)
}

function urlClass(url: string | undefined): 'secret' | 'bad' | 'ok' {
    if (!url || url.includes('${')) return url?.includes('${') ? 'secret' : 'bad'
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return 'bad'
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' || url.includes('@')) return 'bad'
    return 'ok'
}

function skillEmbedsTemplate(manifest: ServiceManifest): boolean {
    return manifest.skills.some(skill => TEMPLATE.test(skill.name) || TEMPLATE.test(skill.description) || TEMPLATE.test(skill.body))
}

function bearerOrAnonymous(method: AuthMethod, server: McpServerTemplate): DesktopServiceMethodAvailability {
    const keys = Object.keys(server.headers)
    if (keys.length === 0 && method.inputs.length === 0) return { id: method.id, supported: true }
    if (keys.length === 1 && keys[0] === 'Authorization') {
        const match = BEARER_VALUE.exec(server.headers.Authorization ?? '')
        const input = method.inputs.length === 1 ? method.inputs[0] : undefined
        if (match && input && input.key === match[1] && input.secret === true && input.type === 'password' && input.required === true) {
            return { id: method.id, supported: true }
        }
        return unsupported(method.id, DESKTOP_METHOD_REASONS.bearer)
    }
    if (keys.length > 0) return unsupported(method.id, DESKTOP_METHOD_REASONS.customHeader)
    return unsupported(method.id, DESKTOP_METHOD_REASONS.bearer)
}

export function classifyDesktopServiceMethod(manifest: ServiceManifest, method: AuthMethod): DesktopServiceMethodAvailability {
    if (method.kind === 'managed' || method.managed) return unsupported(method.id, DESKTOP_METHOD_REASONS.managed)
    if (method.kind === 'composio' || method.composio) return unsupported(method.id, DESKTOP_METHOD_REASONS.composio)
    if (method.kind === 'app' || method.app) return unsupported(method.id, DESKTOP_METHOD_REASONS.app)
    if (method.kind === 'oauth' || method.mcpServers.some(declaresOAuth)) return unsupported(method.id, DESKTOP_METHOD_REASONS.oauth)
    if (method.kind === 'stdio' || method.mcpServers.some(declaresStdio)) return unsupported(method.id, DESKTOP_METHOD_REASONS.stdio)
    if (method.mcpServers.some(server => server.transport === 'sse')) return unsupported(method.id, DESKTOP_METHOD_REASONS.sse)
    if (method.mcpServers.length !== 1) return unsupported(method.id, DESKTOP_METHOD_REASONS.serverCount)

    const server = method.mcpServers[0]
    if (!server) return unsupported(method.id, DESKTOP_METHOD_REASONS.serverCount)
    if (urlClass(server.url) === 'secret') return unsupported(method.id, DESKTOP_METHOD_REASONS.secretUrl)
    if (server.transport !== 'http') return unsupported(method.id, DESKTOP_METHOD_REASONS.transport)
    if (urlClass(server.url) !== 'ok') return unsupported(method.id, DESKTOP_METHOD_REASONS.url)
    if (Object.keys(server.env).length > 0 || method.envKeys.length > 0) return unsupported(method.id, DESKTOP_METHOD_REASONS.env)
    if (server.args.length > 0) return unsupported(method.id, DESKTOP_METHOD_REASONS.args)
    if (skillEmbedsTemplate(manifest)) return unsupported(method.id, DESKTOP_METHOD_REASONS.skill)
    return bearerOrAnonymous(method, server)
}
