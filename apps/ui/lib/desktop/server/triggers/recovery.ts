import 'server-only'
import type { Client } from '@libsql/client'
import type { EngineConnection } from '@/lib/engine/types'
import { recoverDesktopTriggerChats } from './adoption'

/** Bound history recovery before reading local chats — once-only adoption. */
export async function recoverDesktopTriggerHistory(
    db: Client,
    engine: EngineConnection,
    agentId: string,
    options: { signal?: AbortSignal; engineAgentId?: string } = {},
) {
    return recoverDesktopTriggerChats(db, engine, agentId, options)
}
