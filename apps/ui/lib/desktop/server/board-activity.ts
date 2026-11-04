import 'server-only'
import { listRuns } from '@/lib/engine/client'
import type { BoardActivity } from '../board-activity'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { listDesktopAgents } from './store'
import { DESKTOP_ATTENTION_DEADLINE_MS, readDesktopAttention } from './attention'

// Mirrors Rerun's team status: unreachable, working, waiting for a person, then idle.
// Keyed by the local coworker id so engine ids never reach the renderer.
export async function readDesktopBoardActivity(runtime: DesktopRuntime): Promise<BoardActivity> {
    const signal = AbortSignal.timeout(DESKTOP_ATTENTION_DEADLINE_MS)
    const conn = engineOf(runtime)
    const runningReads = (async () => {
        const agents = (await listDesktopAgents(await openDesktopDatabase(runtime.dataRoot))).filter(agent => agent.workspaceId === 1)
        return Promise.all(agents.map(async agent => {
            try {
                signal.throwIfAborted()
                const running = await listRuns(conn, agent.engineAgentId, { status: 'running', limit: 1 }, { signal })
                return [agent.id, running.length > 0 ? 'working' : 'idle'] as const
            } catch {
                return [agent.id, 'unreachable'] as const
            }
        }))
    })()
    const [entries, attention] = await Promise.all([runningReads, readDesktopAttention(runtime)])
    const waiting = new Set(attention.items.map(item => item.agentId))
    const unavailable = new Set(attention.unavailableAgentIds)
    return { agents: Object.fromEntries(entries.map(([id, status]) => [id,
        status !== 'idle' ? status : waiting.has(id) ? 'waiting_human' : unavailable.has(id) ? 'unreachable' : 'idle',
    ])), attention }
}
