import 'server-only'
import { resolve } from 'node:path'
import type { Client, Row } from '@libsql/client'
import { z } from 'zod'
import { completionIdentityOf, cursorOf, groupCompletions, parseCompletionIdentity, parseCursor,
    type CompletionRow, type DesktopCompletionIdentity, type DesktopCompletionItem, type DesktopCompletions } from '../completed-actions'
import { listAgentCompletions, type EngineRunCompletion } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import { initializeDesktopCompletions } from './completed-actions-db'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
export { initializeDesktopCompletions, DESKTOP_COMPLETIONS_SCHEMA } from './completed-actions-db'

export const DESKTOP_COMPLETIONS_CONCURRENCY = 4
export const DESKTOP_COMPLETIONS_DEADLINE_MS = 2_500
const DEFAULT_LIMIT = 20, MAX_LIMIT = 50
type Owner = { id: string; engineId: string; name: string; enabled: boolean; deleting: boolean }
type Raw = { row: EngineRunCompletion; owner: Owner }
const ownerSql = `SELECT a.id,a.engine_agent_id,a.name,a.enabled,d.agent_id AS deleting FROM desktop_agents a
    LEFT JOIN desktop_deletions d ON d.agent_id=a.id WHERE a.workspace_id=1`
const ownersOf = (rows: Row[]) => new Map(rows.map(row => [String(row.id), { id: String(row.id), engineId: String(row.engine_agent_id), name: String(row.name), enabled: Number(row.enabled) !== 0, deleting: row.deleting !== null } satisfies Owner]))
const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1
const rawOrder = (a: Raw, b: Raw) => compare(b.row.completedAt, a.row.completedAt) || compare(b.row.id, a.row.id) || compare(b.owner.id, a.owner.id)
const identity = ({ row, owner }: Raw) => completionIdentityOf({ agentId: owner.id, engineAgentId: owner.engineId, engineSessionId: row.sessionId, terminalId: row.id })

async function workers<T>(tasks: T[], signal: AbortSignal, work: (task: T) => Promise<void>, skipped: (task: T) => void) {
    let next = 0
    await Promise.all(Array.from({ length: Math.min(DESKTOP_COMPLETIONS_CONCURRENCY, tasks.length) }, async () => {
        while (!signal.aborted) {
            const index = next++
            if (index >= tasks.length) return
            await work(tasks[index])
        }
    }))
    tasks.slice(next).forEach(skipped)
}

async function collect(runtime: DesktopRuntime, options: { limit: number; before?: string }): Promise<DesktopCompletions> {
    const signal = AbortSignal.timeout(DESKTOP_COMPLETIONS_DEADLINE_MS)
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCompletions(db)
    const cutoff = (await db.execute('SELECT enabled_at FROM desktop_completions_state WHERE id=1')).rows[0]
    const enabledAt = String(cutoff.enabled_at)
    const cursor = parseCursor(options.before)
    if (options.before && !cursor) throw new DesktopHttpError(400, 'Invalid finished-runs cursor.')
    const owners = [...ownersOf((await db.execute(ownerSql)).rows).values()]
    const unavailable = new Set<string>(), raw: Raw[] = []
    let hasUnfetched = false
    await workers(owners, signal, async owner => {
        if (owner.deleting) { unavailable.add(owner.id); return }
        try {
            const rows = await listAgentCompletions(engineOf(runtime), owner.engineId, {
                limit: options.limit + 1, signal,
                ...(cursor ? { before: { completedAt: cursor.completedAt, id: cursor.id, inclusiveId: owner.id < cursor.agentId } } : {}),
            })
            if (rows.some(row => row.agentId !== owner.engineId || !Number.isFinite(Date.parse(row.completedAt)))) throw new Error('Invalid completion owner or timestamp')
            if (rows.length > options.limit) hasUnfetched = true
            const seen = new Set<string>()
            for (const row of rows) if (!seen.has(row.id)) { seen.add(row.id); raw.push({ owner, row }) }
        } catch { unavailable.add(owner.id) }
    }, owner => unavailable.add(owner.id))

    // Consume raw rows, including acknowledged/deleted-session rows, before folding. An old
    // member of one group must never advance the cursor past an unreturned conversation.
    raw.sort(rawOrder)
    const page = raw.slice(0, options.limit)
    const last = page.at(-1)
    const nextCursor = last && (raw.length > page.length || hasUnfetched)
        ? cursorOf({ completedAt: last.row.completedAt, id: last.row.id, agentId: last.owner.id }) : null
    const ids = page.map(identity)
    const [ownerRows, sessionRows, seenRows] = await db.batch([
        ownerSql,
        { sql: `SELECT s.id,s.agent_id,s.engine_session_id,s.title FROM desktop_sessions s JOIN desktop_agents a ON a.id=s.agent_id
            WHERE a.workspace_id=1 AND (${page.map(() => '(s.agent_id=? AND s.engine_session_id=?)').join(' OR ') || '0'})`,
            args: page.flatMap(item => [item.owner.id, item.row.sessionId]) },
        { sql: `SELECT completion_id FROM desktop_completions_seen WHERE completion_id IN (${ids.map(() => '?').join(',') || 'NULL'})`, args: ids },
    ], 'read')
    const currentOwners = ownersOf(ownerRows.rows)
    const sessions = new Map(sessionRows.rows.map(row => [`${row.agent_id}\0${row.engine_session_id}`, row]))
    const seen = new Set(seenRows.rows.map(row => String(row.completion_id)))
    const owned: CompletionRow[] = []
    for (const item of page) {
        const owner = currentOwners.get(item.owner.id)
        if (!owner) continue
        if (owner.deleting || owner.engineId !== item.owner.engineId) { unavailable.add(owner.id); continue }
        if (item.row.completedAt < enabledAt) continue
        const session = sessions.get(`${owner.id}\0${item.row.sessionId}`), id = identity(item)
        if (!session || seen.has(id)) continue
        owned.push({ ...item.row, id, agentId: owner.id, sessionId: String(session.id), title: String(session.title) })
    }
    const items: DesktopCompletionItem[] = groupCompletions(owned).map(group => {
        const owner = currentOwners.get(group.agentId)!
        return { id: `done:${group.key}`, agentId: owner.id, agentName: owner.name, agentEnabled: owner.enabled,
            sessionId: group.sessionId, sessionIds: [...new Set(group.sessionIds)], title: group.title, message: group.message,
            source: group.source, slug: group.slug, count: group.count, completedAt: group.completedAt, completionIds: group.completionIds }
    })
    return { items, unavailableAgentIds: [...unavailable].filter(id => currentOwners.has(id)).sort(), enabledAt, nextCursor, checkedAt: new Date().toISOString() }
}

const shared = globalThis as typeof globalThis & { desktopCompletionReads?: Map<string, Promise<DesktopCompletions>> }
export function readDesktopCompletions(runtime: DesktopRuntime, options: { limit?: number; before?: string } = {}): Promise<DesktopCompletions> {
    const limit = options.limit === undefined || !Number.isFinite(options.limit) ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit)))
    const key = JSON.stringify([resolve(runtime.dataRoot), runtime.launchNonce, runtime.engine.origin, limit, options.before ?? ''])
    const reads = shared.desktopCompletionReads ??= new Map(), pending = reads.get(key)
    if (pending) return pending
    const work = collect(runtime, { limit, before: options.before })
    reads.set(key, work)
    const release = () => { if (reads.get(key) === work) reads.delete(key) }
    void work.then(release, release)
    return work
}

export const desktopCompletionReadSchema = z.object({ completionIds: z.array(z.string().min(1).max(8192)).max(500) }).strict()
export async function markDesktopCompletionsRead(runtime: DesktopRuntime, input: { completionIds: string[] }): Promise<{ marked: number }> {
    const db: Client = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCompletions(db)
    const ids = [...new Set(input.completionIds)]
    if (!ids.length) return { marked: 0 }
    const parsed = ids.map(id => ({ id, value: parseCompletionIdentity(id) }))
    if (parsed.some(item => !item.value)) throw new DesktopHttpError(400, 'Choose the exact finished-run items to mark as read.')
    const targets = parsed as Array<{ id: string; value: DesktopCompletionIdentity }>
    const owners = ownersOf((await db.execute(ownerSql)).rows)
    const batches = new Map<string, typeof targets>()
    for (const item of targets) {
        const owner = owners.get(item.value.agentId)
        if (!owner || owner.engineId !== item.value.engineAgentId) throw new DesktopHttpError(404, 'Finished run not found.')
        if (owner.deleting) throw new DesktopHttpError(503, 'This coworker is being removed. Try again once that finishes.')
        batches.set(owner.id, [...(batches.get(owner.id) ?? []), item])
    }
    const tasks = [...batches.values()].flatMap(items => Array.from({ length: Math.ceil(items.length / 100) }, (_, index) => items.slice(index * 100, (index + 1) * 100)))
    const signal = AbortSignal.timeout(DESKTOP_COMPLETIONS_DEADLINE_MS)
    let unavailable = false
    const confirmed = new Set<string>()
    await workers(tasks, signal, async items => {
        try {
            const rows = await listAgentCompletions(engineOf(runtime), items[0].value.engineAgentId, { ids: items.map(item => item.value.terminalId), signal })
            for (const item of items) if (rows.some(row => row.id === item.value.terminalId && row.agentId === item.value.engineAgentId && row.sessionId === item.value.engineSessionId)) confirmed.add(item.id)
        } catch { unavailable = true }
    }, () => { unavailable = true })
    if (unavailable) throw new DesktopHttpError(503, 'Could not confirm these finished runs. Try again.')
    if (confirmed.size !== targets.length) throw new DesktopHttpError(404, 'Finished run not found.')
    // Revalidate after the network inside one write transaction so a stale action cannot
    // acknowledge a different owner/session after deletion or engine rebinding.
    const transaction = await db.transaction('write')
    try {
        const current = ownersOf((await transaction.execute(ownerSql)).rows)
        const seenAt = new Date().toISOString()
        for (const { id, value } of targets) {
            const owner = current.get(value.agentId)
            if (!owner || owner.engineId !== value.engineAgentId) throw new DesktopHttpError(404, 'Finished run not found.')
            if (owner.deleting) throw new DesktopHttpError(503, 'This coworker is being removed. Try again once that finishes.')
            const session = (await transaction.execute({ sql: 'SELECT id FROM desktop_sessions WHERE agent_id=? AND engine_session_id=?', args: [value.agentId, value.engineSessionId] })).rows[0]
            if (!session) throw new DesktopHttpError(404, 'Conversation not found.')
            await transaction.execute({ sql: 'INSERT INTO desktop_completions_seen (completion_id,agent_id,session_id,seen_at) VALUES (?,?,?,?) ON CONFLICT(completion_id) DO NOTHING', args: [id, value.agentId, String(session.id), seenAt] })
        }
        await transaction.commit()
    } finally { transaction.close() }
    return { marked: targets.length }
}
