import 'server-only'
import { EngineRequestError } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent } from './store'

export async function withCoworkerMemories<T>(runtime: DesktopRuntime, agentId: string, action: (engine: EngineConnection, id: string) => Promise<T>): Promise<T> {
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    try {
        return await action(engineOf(runtime), coworker.engineAgentId)
    } catch (cause) {
        if (cause instanceof EngineRequestError) {
            if (cause.status === 404) throw new DesktopHttpError(404, 'Coworker or memory not found.')
            if (cause.status === 400) throw new DesktopHttpError(400, 'Check the memory content and try again.')
            if (cause.status === 409) throw new DesktopHttpError(409, 'This memory conflicts with an existing note.')
            if (cause.status === 403) throw new DesktopHttpError(403, 'Cannot access this coworker’s memory storage.')
        }
        throw new DesktopHttpError(502, 'The memory request failed. Try again.')
    }
}
