import { unwrapToolOutputEnvelope } from './tool-output.js'

export type McpRegisterCard = { name: string; url?: string; outcome: 'saved' | 'failed'; failure?: string }

// The engine answers mcp_register and mcp_login in prose written for the model. Every refusal of
// mcp_register says "Nothing was saved", which is the one sentence this relies on.
const NOT_SAVED = 'Nothing was saved'

function outputText(output: unknown): string {
    const value = unwrapToolOutputEnvelope(output)
    return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function failureOf(text: string): string {
    const firstLine = text.split('\n')[0].trim()
    return firstLine.match(/ via \w+: (.+)$/)?.[1] ?? firstLine
}

// Null when the call says nothing about a server the user could act on: the generic step stays.
export function mcpRegisterCardOf(toolName: string, input: unknown, output: unknown): McpRegisterCard | null {
    const args = (input ?? {}) as { name?: unknown; url?: unknown }
    if (typeof args.name !== 'string' || !args.name) return null
    const url = typeof args.url === 'string' ? args.url : undefined
    const text = outputText(output)
    if (toolName === 'mcp_register') {
        if (text.includes(NOT_SAVED)) return { name: args.name, url, outcome: 'failed', failure: failureOf(text) }
        return { name: args.name, url, outcome: 'saved' }
    }
    if (toolName === 'mcp_login') {
        if (text.startsWith('No MCP server named') || text.includes('stdio-based')) return null
        return { name: args.name, outcome: 'saved' }
    }
    return null
}
