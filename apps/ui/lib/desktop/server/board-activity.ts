import 'server-only'
import { listRuns } from '@/lib/engine/client'
import type { BoardActivity } from '../board-activity'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { listDesktopAgents } from './store'

// Mirrors Rerun's team status: any running run ⇒ working; a failed engine read ⇒ unreachable; otherwise idle.
// Keyed by the local coworker id so engine ids never reach the renderer.
export async function readDesktopBoardActivity(runtime: DesktopRuntime): Promise<BoardActivity> {
    const agents = await listDesktopAgents(await openDesktopDatabase(runtime.dataRoot))
    const conn = engineOf(runtime)
    const entries = await Promise.all(agents.map(async agent => {
        try {
            const running = await listRuns(conn, agent.engineAgentId, { status: 'running', limit: 1 })
            return [agent.id, running.length > 0 ? 'working' : 'idle'] as const
        } catch {
            return [agent.id, 'unreachable'] as const
        }
    }))
    return { agents: Object.fromEntries(entries) }
}
