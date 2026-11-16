import 'server-only'
import type { Client } from '@libsql/client'
import {
    DESKTOP_ACTIVITY_DELETED_COWORKER, DESKTOP_ACTIVITY_MAX_RECORDS, DESKTOP_ACTIVITY_OUTCOMES, DESKTOP_ACTIVITY_SOURCES, FOREMAN_AGENT_ID,
    desktopActivityCsv, desktopActivityPageSchema, desktopActivityRuleWords, desktopActivitySentence, type DesktopActivityPage,
} from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import type { DesktopActivityRow, DesktopActivityView } from '../activity'
import { listDesktopAgents, type DesktopAgent } from './store'

// The trail itself is the engine's, written where each action is decided. The app only reads it,
// and adds what the engine does not know: the coworker's name on this Mac and the saved
// conversation an action belongs to.

const FOREMAN_NAME = 'Chief of Staff'
const HELPER_NAME = 'A helper'

/** The engine's filters for a request to the view. Unknown values are dropped, never passed on. */
export function engineActivityQuery(search: URLSearchParams, agents: readonly DesktopAgent[]): URLSearchParams {
    const query = new URLSearchParams()
    const coworker = search.get('coworker') ?? ''
    if (coworker === 'deleted') query.set('except', [...agents.map(agent => agent.engineAgentId), FOREMAN_AGENT_ID].join(','))
    else if (coworker) query.set('agents', agents.find(agent => agent.id === coworker)?.engineAgentId ?? '')
    const outcome = search.get('outcome') ?? ''
    if ((DESKTOP_ACTIVITY_OUTCOMES as readonly string[]).includes(outcome)) query.set('outcomes', outcome)
    const source = search.get('source') ?? ''
    if ((DESKTOP_ACTIVITY_SOURCES as readonly string[]).includes(source)) query.set('sources', source)
    if (search.get('risky') === '1') query.set('risky', '1')
    for (const key of ['from', 'to'] as const) {
        const value = search.get(key)
        if (value && Number.isFinite(Date.parse(value))) query.set(key, new Date(Date.parse(value)).toISOString())
    }
    const text = search.get('q')?.trim().slice(0, 100)
    if (text) query.set('q', text)
    return query
}

async function conversations(db: Pick<Client, 'execute'>, engineSessionIds: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (let index = 0; index < engineSessionIds.length; index += 200) {
        const ids = engineSessionIds.slice(index, index + 200)
        const { rows } = await db.execute({ sql: `SELECT id, engine_session_id FROM desktop_sessions WHERE engine_session_id IN (${ids.map(() => '?').join(',')})`, args: ids })
        for (const row of rows) found.set(String(row.engine_session_id), String(row.id))
    }
    return found
}

async function rowsOf(db: Pick<Client, 'execute'>, agents: readonly DesktopAgent[], records: DesktopActivityPage['records']): Promise<DesktopActivityRow[]> {
    const byEngineId = new Map(agents.map(agent => [agent.engineAgentId, agent]))
    const sessions = await conversations(db, [...new Set(records.flatMap(record => record.sessionId ? [record.sessionId] : []))])
    return records.map(record => {
        const agent = byEngineId.get(record.agentId)
        const foreman = record.agentId === FOREMAN_AGENT_ID
        // A deleted coworker's past actions stay in the owner's history, without its name.
        const coworker = agent?.name ?? (foreman ? FOREMAN_NAME : record.source === 'delegated' ? HELPER_NAME : DESKTOP_ACTIVITY_DELETED_COWORKER)
        return {
            seq: record.seq, id: record.id, at: record.at, coworker, coworkerId: agent?.id ?? null, deleted: !agent && !foreman && record.source !== 'delegated',
            conversationId: agent && record.sessionId ? sessions.get(record.sessionId) ?? null : null,
            sentence: desktopActivitySentence(coworker, record), outcome: record.outcome, ruleWords: desktopActivityRuleWords(record.rule),
            tool: record.tool, action: record.action, app: record.app, kind: record.kind, source: record.source, sourceSlug: record.sourceSlug,
            durationMs: record.durationMs, summary: record.summary,
        }
    })
}

const page = (engine: EngineConnection, query: URLSearchParams) =>
    request(engine, `/desktop/activity?${query}`, { method: 'GET', cache: 'no-store' }, data => desktopActivityPageSchema.parse(data))

export async function readDesktopActivity(engine: EngineConnection, db: Pick<Client, 'execute'>, search: URLSearchParams): Promise<DesktopActivityView> {
    const agents = await listDesktopAgents(db)
    const query = engineActivityQuery(search, agents)
    const before = Number(search.get('before'))
    if (Number.isSafeInteger(before) && before > 0) query.set('before', String(before))
    const result = await page(engine, query)
    return {
        rows: await rowsOf(db, agents, result.records), next: result.next, total: result.total, dropped: result.dropped,
        coworkers: agents.map(agent => ({ id: agent.id, name: agent.name })),
    }
}

/** Every row of the current filter as CSV: the same redacted fields the view shows. */
export async function exportDesktopActivity(engine: EngineConnection, db: Pick<Client, 'execute'>, search: URLSearchParams): Promise<string> {
    const agents = await listDesktopAgents(db)
    const byEngineId = new Map(agents.map(agent => [agent.engineAgentId, agent.name]))
    const query = engineActivityQuery(search, agents)
    query.set('limit', '500')
    const records: DesktopActivityPage['records'] = []
    for (let next: number | null = null; records.length < DESKTOP_ACTIVITY_MAX_RECORDS;) {
        if (next) query.set('before', String(next))
        const result = await page(engine, query)
        records.push(...result.records)
        if (!result.next) break
        next = result.next
    }
    return desktopActivityCsv(records.map(record => ({
        ...record,
        coworker: byEngineId.get(record.agentId) ?? (record.agentId === FOREMAN_AGENT_ID ? FOREMAN_NAME : record.source === 'delegated' ? HELPER_NAME : DESKTOP_ACTIVITY_DELETED_COWORKER),
    })))
}

/** The view named a coworker the app does not know. Nothing is cleared. */
export class DesktopActivityCoworkerUnknown extends Error {}

// Rows the view shows under "Deleted coworkers": a coworker that is gone, not the Chief of Staff
// and not a helper a coworker started.
async function deletedCoworkerIds(engine: EngineConnection, agents: readonly DesktopAgent[]): Promise<string[]> {
    const query = engineActivityQuery(new URLSearchParams('coworker=deleted'), agents)
    query.set('limit', '500')
    const ids = new Set<string>()
    for (let next: number | null = null, read = 0; read < DESKTOP_ACTIVITY_MAX_RECORDS;) {
        if (next) query.set('before', String(next))
        const result = await page(engine, query)
        for (const record of result.records) if (record.source !== 'delegated' && record.agentId !== FOREMAN_AGENT_ID) ids.add(record.agentId)
        read += result.records.length
        if (!result.next) break
        next = result.next
    }
    return [...ids]
}

/**
 * Clears the trail. With no coworker, all of it. With a coworker's id, or `deleted` for the
 * coworkers that no longer exist, only those rows: every other coworker's rows and the count of
 * actions that could not be recorded stay. A coworker the app does not know clears nothing.
 */
export async function clearDesktopActivity(engine: EngineConnection, db?: Pick<Client, 'execute'>, coworker?: string | null): Promise<void> {
    if (coworker === undefined || coworker === null) {
        await request(engine, '/desktop/activity', { method: 'DELETE' }, () => undefined)
        return
    }
    if (!db || !coworker) throw new DesktopActivityCoworkerUnknown()
    const agents = await listDesktopAgents(db)
    const known = agents.find(agent => agent.id === coworker)?.engineAgentId
    if (coworker !== 'deleted' && !known) throw new DesktopActivityCoworkerUnknown()
    const engineIds = known ? [known] : await deletedCoworkerIds(engine, agents)
    for (const id of engineIds) await request(engine, `/desktop/activity?coworker=${encodeURIComponent(id)}`, { method: 'DELETE' }, () => undefined)
}
