import { unwrapToolOutputEnvelope } from './tool-output.js'

export type McpRegisterCard = { name: string; url?: string; outcome: 'saved' | 'failed'; failure?: string }

// Only a confirmed save may produce an Added card. The desktop adapter also returns
// pending proposals, which must stay in the review flow rather than claim a save.
const NOT_SAVED = /nothing (?:was|is) (?:proposed or )?saved/i

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
        if (/^Proposed MCP server /i.test(text)) return null
        if (NOT_SAVED.test(text)) return { name: args.name, url, outcome: 'failed', failure: failureOf(text) }
        if (text === `Saved ${args.name}.` || text.startsWith(`Connected and registered MCP server "${args.name}" (`)
            || text.startsWith(`Registered MCP server "${args.name}" (`) && text.includes('but it requires sign-in.')) {
            return { name: args.name, url, outcome: 'saved' }
        }
        return null
    }
    if (toolName === 'mcp_login') {
        // Login starts only for a previously registered server. Saved describes that
        // registration, not completed authentication; retain the original card behavior.
        return text === `Saved ${args.name}.` || text.startsWith(`Ask the user to open this URL and sign in to "${args.name}":`)
            ? { name: args.name, outcome: 'saved' } : null
    }
    return null
}
