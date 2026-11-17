import { desktopCodexGrantIds, desktopCodexGrantsOf, desktopCodexToolCatalog, type AgentConfig } from '@rerun/contracts'
import { readAgentConfig } from '../agents/loader.js'
import { withAgentLock } from '../agents/lock.js'
import { HttpError } from '../lib/errors.js'

const active = new Map<string, Map<string, 'codex' | 'claude'>>()

// A native grant is applied at process launch. Acquire it under the same lock that patches
// settings, and retain it until this coworker's model process has been closed.
export function beginDesktopNativeRun(id: string, runId: string, signal: AbortSignal, provider: 'claude' | 'codex') {
    return withAgentLock(id, async () => {
        const config = await readAgentConfig(id)
        signal.throwIfAborted()
        const runs = active.get(id) ?? new Map<string, 'codex' | 'claude'>()
        runs.set(runId, provider)
        active.set(id, runs)
        return config
    })
}

export function endDesktopNativeRun(id: string, runId: string) {
    const runs = active.get(id)
    if (runs?.delete(runId) && !runs.size) active.delete(id)
}

export function assertNativeChangeAllowed(id: string, current: AgentConfig, next: AgentConfig) {
    const before = desktopCodexGrantsOf(current.tools)
    const after = desktopCodexGrantsOf(next.tools)
    const changed = desktopCodexGrantIds.filter(key => before[key] !== after[key])
    const unavailable = changed.find(key => after[key] && !desktopCodexToolCatalog.find(row => row.id === key)?.available)
    if (unavailable) throw new HttpError(409, 'This Codex capability is unavailable on this Mac.')
    const providers = new Set(active.get(id)?.values())
    const claudeChanged = Boolean(current.tools.desktopToolGrants?.claudeSubagents) !== Boolean(next.tools.desktopToolGrants?.claudeSubagents)
    if (providers.has('claude') && claudeChanged) {
        throw new HttpError(409, 'Stop this coworker’s active Claude replies before changing its sub-agent permission.')
    }
    if (providers.has('codex') && changed.length) {
        throw new HttpError(409, 'Stop this coworker’s active Codex replies before changing its native tools.')
    }
}
