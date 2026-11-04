import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { RunTrigger } from '../runtime/context.js'
import { getSystemDb } from './systemDb.js'

// Desktop-only completion store: genuine non-cancelled `done` terminal events, recorded at the
// original terminal-event boundary (`emitRunTerminal`). It is never derived from `runs.status` — a
// run can be stored `done` in the database while ending on a pending question or approval (the
// loop emits a HITL event for those, not a terminal), and cancelled/error terminals never record a
// success. Only the desktop preview writes here (`desktopApp()`); hosted mode keeps its hub
// notifications.
//
// The table is module-owned: `ensureRunCompletions` is idempotent and cheap, and root can fold
// `RUN_COMPLETIONS_DDL` into the central system-db migration by calling it from a ladder step.

export const RUN_COMPLETIONS_DDL = `
CREATE TABLE IF NOT EXISTS run_completions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('chat', 'schedule', 'trigger')),
    slug TEXT,
    completed_at TEXT NOT NULL,
    text TEXT,
    provider TEXT,
    model TEXT,
    cost_micros INTEGER,
    step_count INTEGER
);
CREATE INDEX IF NOT EXISTS run_completions_agent_time_idx ON run_completions(agent_id, completed_at DESC, id DESC);
`

export async function ensureRunCompletions(client: Client): Promise<void> {
    await client.executeMultiple(RUN_COMPLETIONS_DDL)
}

export type RunCompletionRow = {
    id: string
    agentId: string
    sessionId: string
    runId: string | null
    source: 'chat' | 'schedule' | 'trigger'
    slug: string | null
    completedAt: string
    text: string | null
    provider: string | null
    model: string | null
    costMicros: number | null
    stepCount: number | null
}

export type RecordRunCompletionInput = {
    agentId: string
    sessionId: string
    runId: string | null
    trigger: RunTrigger
    text?: string
    provider?: string
    model?: string
    costMicros?: number | null
    stepCount?: number
    /** Terminal-event time; defaults to now when the caller has no timestamp of its own. */
    completedAt?: string
}

// Bounded final-text summary, the same cap the terminal metadata uses: a finished-run card never
// carries more than the last 2000 characters of the run's final answer.
const TEXT_MAX = 2000

export async function recordRunCompletion(input: RecordRunCompletionInput): Promise<void> {
    const { client } = await getSystemDb(input.agentId)
    await ensureRunCompletions(client)
    // The run id is the stable terminal identity: re-emitting the same terminal is a no-op. Only a
    // run without an id (not produced by the loop) falls back to a synthetic key.
    const id = input.runId ?? `${input.agentId}:${input.sessionId}:${Date.now()}:${randomUUID()}`
    const text = input.text?.trim().slice(0, TEXT_MAX) || null
    const slug = input.trigger.source === 'chat' ? null : input.trigger.slug
    await client.execute({
        sql: `INSERT INTO run_completions (id, agent_id, session_id, run_id, source, slug, completed_at, text, provider, model, cost_micros, step_count)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [id, input.agentId, input.sessionId, input.runId, input.trigger.source, slug,
            input.completedAt ?? new Date().toISOString(), text, input.provider ?? null, input.model ?? null,
            input.costMicros ?? null, input.stepCount ?? null],
    })
}

export type ListRunCompletionsOptions = {
    limit: number
    before?: { completedAt: string; id: string }
}

function rowOf(row: Record<string, unknown>): RunCompletionRow {
    return {
        id: String(row.id),
        agentId: String(row.agent_id),
        sessionId: String(row.session_id),
        runId: row.run_id == null ? null : String(row.run_id),
        source: String(row.source) as RunCompletionRow['source'],
        slug: row.slug == null ? null : String(row.slug),
        completedAt: String(row.completed_at),
        text: row.text == null ? null : String(row.text),
        provider: row.provider == null ? null : String(row.provider),
        model: row.model == null ? null : String(row.model),
        costMicros: row.cost_micros == null ? null : Number(row.cost_micros),
        stepCount: row.step_count == null ? null : Number(row.step_count),
    }
}

// Stable bounded read: terminal identity (`id`) and terminal time (`completed_at`) order the rows,
// and `before` is the same (time, id) pair the desktop cursor is built from.
export async function listRunCompletions(agentId: string, options: ListRunCompletionsOptions): Promise<RunCompletionRow[]> {
    const { client } = await getSystemDb(agentId)
    await ensureRunCompletions(client)
    const where = ['agent_id = ?']
    const args: (string | number)[] = [agentId]
    if (options.before) {
        where.push('(completed_at < ? OR (completed_at = ? AND id < ?))')
        args.push(options.before.completedAt, options.before.completedAt, options.before.id)
    }
    const result = await client.execute({
        sql: `SELECT id, agent_id, session_id, run_id, source, slug, completed_at, text, provider, model, cost_micros, step_count
              FROM run_completions WHERE ${where.join(' AND ')} ORDER BY completed_at DESC, id DESC LIMIT ?`,
        args: [...args, options.limit],
    })
    return result.rows.map(rowOf)
}
