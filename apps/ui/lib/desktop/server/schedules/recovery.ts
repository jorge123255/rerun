import 'server-only'
import type { Client } from '@libsql/client'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { findDesktopAgent } from '../store'
import { recoverDesktopScheduledChats, scheduleRead } from './adoption'

export const SCHEDULE_HISTORY_DEADLINE_MS = 2_000
const RETRY_MS = 30_000
type Entry = { pending?: Promise<boolean>; recovered?: boolean; retryAt?: number }
const cacheKey = Symbol.for('rerun.desktop.schedule.history-recovery.v1')
const shared = globalThis as typeof globalThis & { [cacheKey]?: Map<string, Entry> }
const cache = shared[cacheKey] ??= new Map<string, Entry>()

/** Best-effort startup recovery. Never hide valid local history when the engine is unavailable. */
export async function recoverDesktopScheduleHistory(runtime: DesktopRuntime, db: Client, agentId: string): Promise<boolean> {
    const owner = await findDesktopAgent(db, agentId)
    if (!owner) return false
    const key = JSON.stringify([runtime.dataRoot, runtime.launchNonce, runtime.engine.origin, owner.id, owner.engineAgentId])
    const current = cache.get(key)
    if (current?.recovered) return true
    if (current?.pending) return current.pending
    if (current?.retryAt && current.retryAt > Date.now()) return false
    const entry: Entry = {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Scheduled history recovery timed out')), SCHEDULE_HISTORY_DEADLINE_MS)
    const pending = scheduleRead(recoverDesktopScheduledChats(db, engineOf(runtime), owner.id, { signal: controller.signal, engineAgentId: owner.engineAgentId }), controller.signal)
        .then(() => { entry.recovered = true; return true }, () => { entry.retryAt = Date.now() + RETRY_MS; return false })
        .finally(() => { clearTimeout(timer); delete entry.pending })
    entry.pending = pending
    cache.set(key, entry)
    if (cache.size > 500) for (const [oldKey, old] of cache) { if (!old.pending && oldKey !== key) { cache.delete(oldKey); break } }
    return pending
}
