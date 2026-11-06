import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
    EXTERNAL_MCP_COPY,
    EXTERNAL_MCP_DEFAULT_PROTOCOL_VERSION,
    EXTERNAL_MCP_PROTOCOL_VERSIONS,
    externalMcpToolRegistrationSchema,
    externalMcpToolResultSchema,
    type ExternalMcpToolResult,
} from '@rerun/contracts'

export type ExternalMcpRpc = { status: number; body: unknown | null }

export type ExternalMcpCallFailure = { ok: false; status: number; code: string; message: string }
export type ExternalMcpProtocolDeps = {
    listTools(): Promise<unknown>
    callTool(name: string, args: Record<string, unknown>): Promise<ExternalMcpToolResult | ExternalMcpCallFailure>
}

function result(id: unknown, value: unknown): ExternalMcpRpc {
    return { status: 200, body: { jsonrpc: '2.0', id, result: value } }
}

function failure(id: unknown, code: number, message: string): ExternalMcpRpc {
    return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } }
}

/** JSON-RPC subset from the account MCP route, with SDK schemas for list and call. No URL token and no SSE session. */
export async function handleExternalMcpMessage(raw: unknown, deps: ExternalMcpProtocolDeps): Promise<ExternalMcpRpc> {
    const message = raw && typeof raw === 'object' ? raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } : {}
    if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
        return { status: 202, body: null }
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(message.id ?? null, -32600, 'Invalid request')
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : undefined

    if (message.method === 'initialize') {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = (EXTERNAL_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : EXTERNAL_MCP_DEFAULT_PROTOCOL_VERSION
        return result(message.id ?? null, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'rerun', version: '1.0.0' } })
    }
    if (message.method === 'ping') return result(message.id ?? null, {})
    if (message.method === 'tools/list') {
        if (!ListToolsRequestSchema.safeParse(raw).success) return failure(message.id ?? null, -32602, 'Invalid params')
        try {
            const tools = externalMcpToolRegistrationSchema.array().parse(await deps.listTools())
            return result(message.id ?? null, { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) })
        } catch (error) {
            return failure(message.id ?? null, -32001, error instanceof Error && error.message ? error.message : EXTERNAL_MCP_COPY.adapterMissing)
        }
    }
    if (message.method === 'tools/call') {
        const parsed = CallToolRequestSchema.safeParse(raw)
        if (!parsed.success) return failure(message.id ?? null, -32602, 'Invalid params')
        const outcome = await deps.callTool(parsed.params.name, parsed.params.arguments ?? {})
        if ('ok' in outcome && outcome.ok === false) {
            if (outcome.status === 200) return failure(message.id ?? null, -32001, outcome.message)
            return { status: outcome.status, body: { ok: false, code: outcome.code, message: outcome.message } }
        }
        const tool = externalMcpToolResultSchema.safeParse(outcome)
        if (!tool.success) return failure(message.id ?? null, -32001, EXTERNAL_MCP_COPY.adapterMissing)
        return result(message.id ?? null, tool.data)
    }
    return failure(message.id ?? null, -32601, `Method not found: ${message.method}`)
}
