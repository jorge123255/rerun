import { agentExists, loadAgentFromDisk } from './loader.js'
import type { LoadedAgent } from './types.js'
import { notFound } from '../lib/errors.js'
import { releaseAgentMcp } from '../tools/mcp-pool.js'
import { assertDesktopAgentNotDeleted } from '../desktop/agent-lifecycle.js'

const cache = new Map<string, LoadedAgent>()

export async function getAgent(id: string): Promise<LoadedAgent> {
    assertDesktopAgentNotDeleted(id)
    const cached = cache.get(id)
    if (cached) return cached
    if (!agentExists(id)) throw notFound('agent')
    const agent = await loadAgentFromDisk(id)
    cache.set(id, agent)
    return agent
}

export function unloadAgent(id: string): void {
    cache.delete(id)
    releaseAgentMcp(id)
}

// Every LoadedAgent carries the shared instance of its box connection, so a connection edit
// invalidates all of them at once rather than being tracked per agent.
export function clearAgentCache(): void {
    cache.clear()
}

// A server still declared keeps its connection: the pool redials it on its own if how it is dialed
// changed. One taken out of the config is closed now rather than left to idle out.
export async function reloadAgent(id: string): Promise<LoadedAgent> {
    cache.delete(id)
    const agent = await getAgent(id)
    const declared = agent.config.mcpServers.map(server => server.name)
    releaseAgentMcp(id, declared)
    return agent
}

export function activeAgentCount(): number {
    return cache.size
}
