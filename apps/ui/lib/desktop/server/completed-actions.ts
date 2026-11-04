import 'server-only'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import {
    cursorOf, groupCompletions, parseCursor,
    type CompletionGroup, type CompletionRow, type DesktopCompletionItem, type DesktopCompletions,
} from '../completed-actions'
import { listAgentCompletions, type EngineRunCompletion } from '@/lib/engine/client'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopSession, listDesktopAgents, listDesktopSessions, type DesktopAgent, type DesktopSession } from './store'

export const DESKTOP_COMPLETIONS_CONCURRENCY = 4
export const DESKTOP_COMPLETIONS_DEADLINE_MS = 2_500
const DESKTOP_COMPLETIONS_DEFAULT_LIMIT = 20
const DESKTOP_COMPLETIONS_MAX_LIMIT = 50
// The bounded per-agent fetch window: larger than the page so scheduled folding stays meaningful,
// never a full history scan.
const DESKTOP_COMPLETIONS_WINDOW = 100

// Module-owned desktop schema. Root integrates it into the central `initialize` by calling
// `initializeDesktopCompletions(db)` beside the other CREATE TABLE statements; the module also
// ensures it lazily, so the slice works standalone.
export const DESKTOP_COMPLETIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_completions_seen (
    completion_id TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_completions_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled_at TEXT NOT NULL
);
`

// First-enable cutoff: the list covers completions recorded after the desktop feature was first
// initialized. Written once; historical `done` rows are never backfilled into the list.
export async function initializeDesktopCompletions(db: Client): Promise<void> {
    await db.executeMultiple(DESKTOP_COMPLETIONS_SCHEMA)
    await db.execute({ sql: 'INSERT OR IGNORE INTO desktop_completions_state (id, enabled_at) VALUES (1, ?)', args: [new Date().toISOString()] })
}

async function enabledAtOf(db: Client): Promise<string> {
    const result = await db.execute('SELECT enabled_at FROM desktop_completions_state WHERE id = 1')
    const value = result.rows[0]?.enabled_at
    return typeof value === 'string' ? value : new Date().toISOString()
}

async function seenIdsOf(db: Client): Promise<Set<string>> {
    const result = await db.execute('SELECT completion_id FROM desktop_completions_seen')
    return new Set(result.rows.map(row => String(row.completion_id)))
}

const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0 }

function clampLimit(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return DESKTOP_COMPLETIONS_DEFAULT_LIMIT
    return Math.max(1, Math.min(Math.floor(value), DESKTOP_COMPLETIONS_MAX_LIMIT))
}

async function collect(runtime: DesktopRuntime, options: { limit: number; before?: string }): Promise<DesktopCompletions> {
    const signal = AbortSignal.timeout(DESKTOP_COMPLETIONS_DEADLINE_MS)
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCompletions(db)
    const enabledAt = await enabledAtOf(db)
    const cutoff = time(enabledAt)
    const cursor = parseCursor(options.before)
    const agents = (await listDesktopAgents(db)).filter(agent => agent.workspaceId === 1)
    const unavailable = new Set<string>()
    const engine = engineOf(runtime)

    // Engine reads stay inside the same whole-scan bound as the attention projection: four active
    // fetches and a shared deadline. Owners not reached by the workers stay explicitly unknown.
    const engineRows: Array<{ row: EngineRunCompletion; agent: DesktopAgent }> = []
    let next = 0
    await Promise.all(Array.from({ length: Math.min(DESKTOP_COMPLETIONS_CONCURRENCY, agents.length) }, async () => {
        for (;;) {
            if (signal.aborted) return
            const agent = agents[next++]
            if (!agent) return
            try {
                const rows = await listAgentCompletions(engine, agent.engineAgentId, {
                    limit: DESKTOP_COMPLETIONS_WINDOW,
                    ...(cursor ? { before: cursorOf(cursor) } : {}),
                    signal,
                })
                if (rows.some(row => row.agentId !== agent.engineAgentId)) { unavailable.add(agent.id); continue }
                for (const row of rows) engineRows.push({ row, agent })
            } catch { unavailable.add(agent.id) }
        }
    }))
    for (const agent of agents.slice(next)) unavailable.add(agent.id)

    // Join only current locally owned coworkers and exact local sessions: a completion whose engine
    // session no longer maps to a local conversation (deleted or moved) is honestly dropped — it
    // can no longer be opened.
    const sessionByEngine = new Map<string, DesktopSession>()
    for (const agent of agents) {
        try {
            for (const session of await listDesktopSessions(db, agent.id)) {
                if (session.agentId !== agent.id) continue
                sessionByEngine.set(`${agent.engineAgentId}\0${session.engineSessionId}`, session)
            }
        } catch { unavailable.add(agent.id) }
    }
    const owned: CompletionRow[] = []
    for (const { row, agent } of engineRows) {
        if (time(row.completedAt) < cutoff) continue
        const session = sessionByEngine.get(`${agent.engineAgentId}\0${row.sessionId}`)
        if (!session) continue
        owned.push({ id: row.id, agentId: agent.id, sessionId: session.id, runId: row.runId, source: row.source,
            slug: row.slug, completedAt: row.completedAt, text: row.text, provider: row.provider, model: row.model,
            costMicros: row.costMicros, stepCount: row.stepCount, title: session.title })
    }

    // A completion acknowledged earlier (this session or a previous run of the app) never comes
    // back: seen state lives in the desktop database and survives restarts.
    const seen = await seenIdsOf(db)
    const visible = owned
        .filter(row => !seen.has(row.id))
        .sort((a, b) => time(b.completedAt) - time(a.completedAt) || b.id.localeCompare(a.id))
    const groups = groupCompletions(visible)
    const page = groups.slice(0, options.limit)

    // Stable cursor: the (time, id) of the oldest completion the page consumed. Anything strictly
    // older still in the fetched window pages next; nothing on this page is ever re-shown.
    let nextCursor: string | null = null
    if (page.length > 0) {
        const lastIndex = Math.max(...page.flatMap(group => group.completionIds).map(id => visible.findIndex(row => row.id === id)))
        if (lastIndex >= 0 && lastIndex < visible.length - 1) nextCursor = cursorOf(visible[lastIndex])
    }

    // Revalidate the current roster and the exact session before publishing, like the attention
    // read: deletion or reassignment during the scan must not surface a stale navigation target.
    const currentAgents = new Map((await listDesktopAgents(db)).filter(agent => agent.workspaceId === 1).map(agent => [agent.id, agent]))
    const items: DesktopCompletionItem[] = []
    for (const group of page) {
        const agent = currentAgents.get(group.agentId)
        if (!agent) continue
        try {
            const current = await findDesktopSession(db, group.sessionId)
            if (!current || current.agentId !== agent.id) continue
            await assertCoworkerNotDeleting(db, agent.id)
            items.push(itemOf(group, agent, current))
        } catch { unavailable.add(agent.id) }
    }
    items.sort((a, b) => time(b.completedAt) - time(a.completedAt) || a.id.localeCompare(b.id))

    return {
        items,
        unavailableAgentIds: [...unavailable].filter(id => currentAgents.has(id)).sort(),
        enabledAt,
        nextCursor,
        checkedAt: new Date().toISOString(),
    }
}

function itemOf(group: CompletionGroup, agent: DesktopAgent, session: DesktopSession): DesktopCompletionItem {
    return {
        id: `done:${group.key}`,
        agentId: agent.id,
        agentName: agent.name,
        agentEnabled: agent.enabled,
        sessionId: session.id,
        sessionIds: group.sessionIds,
        title: group.source === 'chat' ? session.title : group.title,
        message: group.message,
        source: group.source,
        slug: group.slug,
        count: group.count,
        completedAt: group.completedAt,
        completionIds: group.completionIds,
    }
}

// Route bundles share this process-global in-flight read, keyed by pagination inputs. Seen writes
// are never bundled: mark-read goes through its own mutation. This is a read snapshot, not an
// admission decision; the opened chat revalidates the card.
const shared = globalThis as typeof globalThis & { desktopCompletionReads?: Map<string, Promise<DesktopCompletions>> }

export function readDesktopCompletions(runtime: DesktopRuntime, options: { limit?: number; before?: string } = {}): Promise<DesktopCompletions> {
    const limit = clampLimit(options.limit)
    const before = options.before ?? ''
    const key = JSON.stringify([resolve(runtime.dataRoot), runtime.launchNonce, runtime.engine.origin, limit, before])
    const reads = shared.desktopCompletionReads ??= new Map()
    const pending = reads.get(key)
    if (pending) return pending
    const work = collect(runtime, { limit, ...(before ? { before } : {}) })
    reads.set(key, work)
    const release = () => { if (reads.get(key) === work) reads.delete(key) }
    void work.then(release, release)
    return work
}

// Explicit authenticated mark-read. The client sends exactly the completion IDs it displayed, so
// a newer arrival in the same conversation or scheduled task (a different terminal identity) is
// never accidentally cleared.
export const desktopCompletionReadSchema = z.object({
    completionIds: z.array(z.string().min(1)).max(500),
}).strict()

export async function markDesktopCompletionsRead(runtime: DesktopRuntime, input: { completionIds: string[] }): Promise<{ marked: number }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCompletions(db)
    const ids = [...new Set(input.completionIds)]
    if (ids.length === 0) return { marked: 0 }
    const seenAt = new Date().toISOString()
    await db.batch(ids.map(id => ({
        sql: 'INSERT INTO desktop_completions_seen (completion_id, seen_at) VALUES (?, ?) ON CONFLICT(completion_id) DO NOTHING',
        args: [id, seenAt],
    })), 'write')
    return { marked: ids.length }
}
