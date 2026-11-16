import type { Client, InValue } from '@libsql/client'
import {
    DESKTOP_ACTIVITY_MAX_RECORDS, DESKTOP_ACTIVITY_PAGE, DESKTOP_ACTIVITY_RETENTION_DAYS,
    desktopActivityRecordSchema, type DesktopActivityFilters, type DesktopActivityPage, type DesktopActivityRecord,
} from '@rerun/contracts'
import { activityDbDir, activityDbPath } from '../../config/paths.js'
import { openStore } from '../../db/sqlStore.js'

// One database for the workspace, in the engine's data folder on this Mac. It sits beside the
// coworkers' own databases rather than inside one, so deleting a coworker leaves its past actions
// in the owner's history. Rows are only ever added, pruned by age or count, or cleared as a whole.
const DDL = [
    `CREATE TABLE IF NOT EXISTS desktop_activity (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        source TEXT NOT NULL,
        source_slug TEXT,
        tool TEXT NOT NULL,
        action TEXT,
        app TEXT,
        kind TEXT,
        outcome TEXT NOT NULL,
        rule TEXT,
        duration_ms INTEGER,
        summary TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS desktop_activity_at_idx ON desktop_activity(at)',
    'CREATE INDEX IF NOT EXISTS desktop_activity_agent_idx ON desktop_activity(agent_id, seq)',
    'CREATE TABLE IF NOT EXISTS desktop_activity_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
]

/** How many old rows one write may remove: pruning never turns a tool call into a long delete. */
export const ACTIVITY_PRUNE_BATCH = 500

const ready = new WeakMap<Client, Promise<void>>()
function ensure(client: Client): Promise<void> {
    let done = ready.get(client)
    if (!done) {
        done = (async () => { for (const sql of DDL) await client.execute(sql) })().catch(error => { ready.delete(client); throw error })
        ready.set(client, done)
    }
    return done
}

const COLUMNS = 'id,at,agent_id,session_id,run_id,source,source_slug,tool,action,app,kind,outcome,rule,duration_ms,summary'

function recordOf(row: Record<string, unknown>): DesktopActivityRecord & { seq: number } {
    const text = (value: unknown) => value === null || value === undefined ? null : String(value)
    return {
        seq: Number(row.seq),
        ...desktopActivityRecordSchema.parse({
            id: String(row.id), at: String(row.at), agentId: String(row.agent_id), sessionId: text(row.session_id), runId: text(row.run_id),
            source: String(row.source), sourceSlug: text(row.source_slug), tool: String(row.tool), action: text(row.action), app: text(row.app), kind: text(row.kind),
            outcome: String(row.outcome), rule: text(row.rule), durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms), summary: text(row.summary),
        }),
    }
}

const like = (value: string) => `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`

function where(filters: DesktopActivityFilters): { sql: string; args: InValue[] } {
    const parts: string[] = []
    const args: InValue[] = []
    const list = (column: string, values: readonly string[] | undefined, negate = false) => {
        if (!values) return
        if (!values.length) { if (!negate) parts.push('0'); return }
        parts.push(`${column} ${negate ? 'NOT ' : ''}IN (${values.map(() => '?').join(',')})`)
        args.push(...values)
    }
    list('agent_id', filters.agentIds?.slice(0, 500))
    list('agent_id', filters.excludeAgentIds?.slice(0, 500), true)
    list('outcome', filters.outcomes)
    list('source', filters.sources)
    if (filters.risky) parts.push('kind IS NOT NULL')
    if (filters.from) { parts.push('at >= ?'); args.push(filters.from) }
    if (filters.to) { parts.push('at <= ?'); args.push(filters.to) }
    const search = filters.search?.trim().slice(0, 100)
    if (search) {
        parts.push("(tool LIKE ? ESCAPE '\\' OR IFNULL(app,'') LIKE ? ESCAPE '\\' OR IFNULL(action,'') LIKE ? ESCAPE '\\' OR REPLACE(tool,'_',' ') LIKE ? ESCAPE '\\')")
        args.push(like(search), like(search), like(search), like(search))
    }
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', args }
}

export function createActivityStore(client: Client) {
    return {
        /** Adds the rows in one transaction, then prunes a small batch by age and by count. */
        async append(rows: readonly DesktopActivityRecord[], now = new Date()): Promise<void> {
            if (!rows.length) return
            await ensure(client)
            await client.batch(rows.map(row => ({
                sql: `INSERT OR IGNORE INTO desktop_activity(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                args: [row.id, row.at, row.agentId, row.sessionId, row.runId, row.source, row.sourceSlug, row.tool, row.action, row.app, row.kind, row.outcome, row.rule, row.durationMs, row.summary],
            })), 'write')
            await this.prune(now)
        },
        async prune(now = new Date()): Promise<number> {
            await ensure(client)
            const cutoff = new Date(now.getTime() - DESKTOP_ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString()
            const aged = await client.execute({ sql: 'DELETE FROM desktop_activity WHERE seq IN (SELECT seq FROM desktop_activity WHERE at < ? ORDER BY seq LIMIT ?)', args: [cutoff, ACTIVITY_PRUNE_BATCH] })
            const extra = await client.execute({
                sql: 'DELETE FROM desktop_activity WHERE seq IN (SELECT seq FROM desktop_activity ORDER BY seq DESC LIMIT ? OFFSET ?)', args: [ACTIVITY_PRUNE_BATCH, DESKTOP_ACTIVITY_MAX_RECORDS],
            })
            return aged.rowsAffected + extra.rowsAffected
        },
        /** Newest first. `before` is the `next` of the page above. */
        async list(filters: DesktopActivityFilters, options: { before?: number | null; limit?: number } = {}): Promise<Omit<DesktopActivityPage, 'dropped'>> {
            await ensure(client)
            const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DESKTOP_ACTIVITY_PAGE)), 500)
            const base = where(filters)
            const total = Number((await client.execute({ sql: `SELECT COUNT(*) AS n FROM desktop_activity${base.sql}`, args: base.args })).rows[0]?.n ?? 0)
            const paged = options.before ? { sql: `${base.sql}${base.sql ? ' AND' : ' WHERE'} seq < ?`, args: [...base.args, options.before] } : base
            const { rows } = await client.execute({ sql: `SELECT seq,${COLUMNS} FROM desktop_activity${paged.sql} ORDER BY seq DESC LIMIT ?`, args: [...paged.args, limit + 1] })
            const records = rows.slice(0, limit).map(row => recordOf(row as unknown as Record<string, unknown>))
            return { records, next: rows.length > limit ? records.at(-1)!.seq : null, total }
        },
        async clear(): Promise<void> {
            await ensure(client)
            await client.batch(['DELETE FROM desktop_activity', 'DELETE FROM desktop_activity_meta'], 'write')
        },
        /** Actions an earlier launch could not record, kept so the count survives a restart. */
        async dropped(): Promise<number> {
            await ensure(client)
            return Number((await client.execute("SELECT value FROM desktop_activity_meta WHERE key='dropped'")).rows[0]?.value ?? 0)
        },
        async addDropped(count: number): Promise<void> {
            if (count <= 0) return
            await ensure(client)
            await client.execute({ sql: "INSERT INTO desktop_activity_meta(key,value) VALUES('dropped',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value", args: [count] })
        },
    }
}
export type ActivityStore = ReturnType<typeof createActivityStore>

let opened: Promise<ActivityStore> | null = null
/** The workspace's trail, in `activity-db/activity.db` under the engine's data folder. */
export function openActivityStore(): Promise<ActivityStore> {
    opened ??= openStore('desktop-activity', activityDbPath(), activityDbDir()).then(createActivityStore).catch(error => { opened = null; throw error })
    return opened
}
