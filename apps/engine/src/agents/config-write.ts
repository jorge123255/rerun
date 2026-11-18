import { writeFile, rename } from 'node:fs/promises'
import { configPath } from '../config/paths.js'
import { BRIDGE_SERVER_NAME, MCP_SERVER_NAME_RE, type AgentConfig, type McpServer } from './types.js'

// Native Claude helpers spend the owner's subscription. Only a grant on this
// coworker after creation can authorize them; copied configuration cannot.
export function clearInheritedClaudeSubagentGrant(config: AgentConfig): boolean {
    if (config.tools.desktopToolGrants?.claudeSubagents !== true) return false
    config.tools.desktopToolGrants.claudeSubagents = false
    return true
}

// tmp + rename so a concurrent reader (loadAgentFromDisk, GET /:id, mcp_status) never
// observes a half-written file: rename is atomic on the same filesystem.
export async function writeAgentConfig(id: string, config: AgentConfig): Promise<void> {
    const target = configPath(id)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 4), 'utf8')
    await rename(tmp, target)
}

// Refused here rather than at the provider, which can only drop the server and has nobody left to
// report it to: a run would start with the config showing the server and the model holding none of
// its tools, and the model has no way to tell that from a server that is simply down.
export class ReservedMcpServerNameError extends Error {
    constructor() {
        super(`"${BRIDGE_SERVER_NAME}" is reserved for the engine's own tools. Register this server under another name, for example "${BRIDGE_SERVER_NAME}_admin".`)
    }
}

export class InvalidMcpServerNameError extends Error {
    constructor(name: string) {
        super(`MCP server name "${name}" is invalid: use 1-64 characters (letters, digits, underscores, hyphens). Tools are exposed as "<server>_<tool>" and providers reject other characters.`)
    }
}

// Only `upsert` is validated: a config already holding an invalid legacy name must stay loadable
// and removable.
export function mergeMcpServers(current: McpServer[], patch: { upsert?: McpServer[]; remove?: string[] }): McpServer[] {
    const removed = new Set(patch.remove ?? [])
    const byName = new Map(current.filter(s => !removed.has(s.name)).map(s => [s.name, s]))
    for (const s of patch.upsert ?? []) {
        if (s.name === BRIDGE_SERVER_NAME) throw new ReservedMcpServerNameError()
        if (!MCP_SERVER_NAME_RE.test(s.name)) throw new InvalidMcpServerNameError(s.name)
        byName.set(s.name, s)
    }
    return [...byName.values()]
}
