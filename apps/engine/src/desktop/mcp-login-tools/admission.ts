import type { McpLoginToolName } from './contract.js'

const instances = new WeakMap<object, { owner: string; name: McpLoginToolName }>()
export function markMcpLoginTool<T extends object>(tool: T, owner: string, name: McpLoginToolName): T {
    instances.set(tool, { owner, name })
    return tool
}

/** A server-supplied name alone never admits a tool across a subscription-provider filter. */
export function isDesktopMcpLoginTool(tool: unknown, name: string, owner: string): boolean {
    if (!tool || typeof tool !== 'object') return false
    const saved = instances.get(tool)
    return saved?.owner === owner && saved.name === name
}
