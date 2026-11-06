import { toToolInputSchema } from '../../tools/mcp-schema.js'
import type { DesktopMcpSseTool } from '@rerun/contracts'

export function normalizeSseTool(input: DesktopMcpSseTool): DesktopMcpSseTool {
    const { schema, note } = toToolInputSchema(input.inputSchema)
    const description = note ? `${input.description ?? input.name}\n\n${note}` : input.description
    if (description && description.length > 8000) throw new Error('Normalized MCP description exceeds limit')
    return { name: input.name, inputSchema: schema, ...(description !== undefined ? { description } : {}) }
}
