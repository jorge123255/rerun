import { logger } from '../../lib/logger.js'
import { toToolInputSchema } from '../../tools/mcp-schema.js'
import type { McpTool } from '../../tools/mcp.js'

// A tool as the model may be handed it, whichever provider carries it: a root union Anthropic would
// refuse is lifted into plain properties, and the rule it carried is appended to the description.
// The caller's catalog entry is never mutated; a new object is returned only when normalisation runs.
export function modelReadyMcpTool(serverName: string, tool: McpTool): McpTool {
    const { schema, note } = toToolInputSchema(tool.inputSchema)
    if (schema === tool.inputSchema) return tool
    logger.debug({ server: serverName, tool: tool.name }, 'mcp: tool schema normalised')
    const description = tool.description ?? tool.name
    return { ...tool, description: note ? `${description}\n\n${note}` : description, inputSchema: schema as McpTool['inputSchema'] }
}

// List tools for a relay without mutating the pooled catalog object the caller still holds.
export function modelReadyMcpTools(serverName: string, tools: readonly McpTool[]): McpTool[] {
    return tools.map(tool => modelReadyMcpTool(serverName, tool))
}
