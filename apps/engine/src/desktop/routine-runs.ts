import type { Client } from '@libsql/client'
import {
    ROUTINE_FAILURES_BEFORE_OFF, ROUTINE_GUARD_MESSAGES, desktopRoutineRunOutcomeSchema, readRoutineReply, routineChecklistOutcome,
    type DesktopRoutineRunOutcome,
} from '@rerun/contracts'
import { getSystemDb } from '../db/systemDb.js'
import { logger } from '../lib/logger.js'
import { withKeyedLock } from '../lib/lock.js'
import { scheduleExists, setScheduleEnabled } from '../schedules/loader.js'

// What a routine run left behind on this Mac, kept beside the coworker's other run records: the
// per-part checklist outcome and the quiet flag for the last-result view, and the count of failed
// runs in a row that switches a broken routine off. Module-owned and additive, like run_completions.
const DDL = `
CREATE TABLE IF NOT EXISTS desktop_routine_run_outcomes (
    run_id TEXT PRIMARY KEY,
    schedule_slug TEXT NOT NULL,
    outcome_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_routine_run_outcomes_slug_idx ON desktop_routine_run_outcomes(schedule_slug, recorded_at DESC);
CREATE TABLE IF NOT EXISTS desktop_routine_health (
    schedule_slug TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    auto_disabled_at TEXT,
    updated_at TEXT NOT NULL
);`

const KEPT_PER_ROUTINE = 50
const initialized = new WeakMap<Client, Promise<void>>()
function ensure(client: Client): Promise<void> {
    let ready = initialized.get(client)
    if (!ready) {
        ready = client.executeMultiple(DDL).then(() => undefined)
        initialized.set(client, ready)
        void ready.catch(() => initialized.delete(client))
    }
    return ready
}
async function db(agentId: string): Promise<Client> {
    const { client } = await getSystemDb(agentId)
    await ensure(client)
    return client
}

export type DesktopRoutineTerminal = {
    agentId: string
    runId: string | null
    slug: string
    name: string
    kind: 'done' | 'error'
    cancelled?: boolean
    text?: string
    /** Present only for a run the scheduler framed in this engine lifetime. */
    routine?: { parts: string[]; test: boolean }
}

export type DesktopRoutineSettlement = {
    /** The reply was only the "nothing to report" marker: no notification, unread mark or inbox item. */
    quiet: boolean
    /** The reply with the marker taken out. */
    text: string | undefined
    /** Set on the failure that switched the routine off. */
    autoDisabled: string | null
}

async function recordOutcome(client: Client, terminal: DesktopRoutineTerminal, outcome: DesktopRoutineRunOutcome) {
    if (!terminal.runId) return
    const now = new Date().toISOString()
    await client.execute({
        sql: 'INSERT INTO desktop_routine_run_outcomes (run_id, schedule_slug, outcome_json, recorded_at) VALUES (?,?,?,?) ON CONFLICT(run_id) DO NOTHING',
        args: [terminal.runId, terminal.slug, JSON.stringify(desktopRoutineRunOutcomeSchema.parse(outcome)), now],
    })
    await client.execute({
        sql: `DELETE FROM desktop_routine_run_outcomes WHERE schedule_slug = ? AND run_id NOT IN (
            SELECT run_id FROM desktop_routine_run_outcomes WHERE schedule_slug = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?)`,
        args: [terminal.slug, terminal.slug, KEPT_PER_ROUTINE],
    })
}

/**
 * Called once at a scheduled run's terminal, before it is announced. A stopped run changes nothing.
 * A finished run records its checklist and quiet flag and clears the failure count. A failed run of
 * a real (not hand-started) firing counts, and the tenth in a row switches the routine off.
 */
export async function settleDesktopRoutineRun(terminal: DesktopRoutineTerminal): Promise<DesktopRoutineSettlement> {
    const reply = terminal.kind === 'done' && !terminal.cancelled ? readRoutineReply(terminal.text) : null
    const settlement: DesktopRoutineSettlement = { quiet: reply?.quiet ?? false, text: reply ? reply.text || undefined : terminal.text, autoDisabled: null }
    if (terminal.cancelled || !terminal.slug) return settlement
    return withKeyedLock(`desktop-routine-health:${terminal.agentId}:${terminal.slug}`, async () => {
        const client = await db(terminal.agentId)
        const now = new Date().toISOString()
        if (reply) {
            const parts = terminal.routine?.parts ?? []
            await recordOutcome(client, terminal, {
                quiet: reply.quiet,
                test: terminal.routine?.test ?? false,
                checklist: parts.length ? routineChecklistOutcome(parts, reply.text) : null,
            })
            await client.execute({
                sql: `INSERT INTO desktop_routine_health (schedule_slug, consecutive_failures, auto_disabled_at, updated_at) VALUES (?,0,NULL,?)
                      ON CONFLICT(schedule_slug) DO UPDATE SET consecutive_failures = 0, updated_at = excluded.updated_at`,
                args: [terminal.slug, now],
            })
            return settlement
        }
        // An interrupted run rebuilt after a restart, or a hand-started test, is not the routine
        // failing on its schedule.
        if (!terminal.routine || terminal.routine.test) return settlement
        const row = (await client.execute({
            sql: `INSERT INTO desktop_routine_health (schedule_slug, consecutive_failures, auto_disabled_at, updated_at) VALUES (?,1,NULL,?)
                  ON CONFLICT(schedule_slug) DO UPDATE SET consecutive_failures = consecutive_failures + 1, updated_at = excluded.updated_at
                  RETURNING consecutive_failures`,
            args: [terminal.slug, now],
        })).rows[0]
        if (Number(row?.consecutive_failures ?? 0) < ROUTINE_FAILURES_BEFORE_OFF || !scheduleExists(terminal.agentId, terminal.slug)) return settlement
        await setScheduleEnabled(terminal.agentId, terminal.slug, false)
        // The count starts over, so switching the routine back on gives it a fresh ten.
        await client.execute({ sql: 'UPDATE desktop_routine_health SET consecutive_failures = 0, auto_disabled_at = ?, updated_at = ? WHERE schedule_slug = ?', args: [now, now, terminal.slug] })
        logger.warn({ agent: terminal.agentId, schedule: terminal.slug }, 'routine switched off after repeated failures')
        return { ...settlement, autoDisabled: ROUTINE_GUARD_MESSAGES.autoOff }
    })
}

export type DesktopRoutineHealthRow = { consecutiveFailures: number; autoDisabledAt: string | null; lastOutcome: (DesktopRoutineRunOutcome & { runId: string }) | null }

/** Health of each named routine. `enabled` clears a stale "switched off" stamp once the person turns it back on. */
export async function readDesktopRoutineHealth(agentId: string, routines: readonly { slug: string; enabled: boolean }[]): Promise<Map<string, DesktopRoutineHealthRow>> {
    const client = await db(agentId)
    const health = new Map((await client.execute('SELECT schedule_slug, consecutive_failures, auto_disabled_at FROM desktop_routine_health')).rows.map(row => [String(row.schedule_slug), row]))
    const result = new Map<string, DesktopRoutineHealthRow>()
    for (const routine of routines) {
        const row = health.get(routine.slug)
        let autoDisabledAt = typeof row?.auto_disabled_at === 'string' ? row.auto_disabled_at : null
        if (autoDisabledAt && routine.enabled) {
            await client.execute({ sql: 'UPDATE desktop_routine_health SET auto_disabled_at = NULL WHERE schedule_slug = ?', args: [routine.slug] })
            autoDisabledAt = null
        }
        const last = (await client.execute({ sql: 'SELECT run_id, outcome_json FROM desktop_routine_run_outcomes WHERE schedule_slug = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1', args: [routine.slug] })).rows[0]
        let lastOutcome: DesktopRoutineHealthRow['lastOutcome'] = null
        if (last) {
            try {
                const parsed = desktopRoutineRunOutcomeSchema.safeParse(JSON.parse(String(last.outcome_json)))
                if (parsed.success) lastOutcome = { ...parsed.data, runId: String(last.run_id) }
            } catch { /* an unreadable row is no outcome */ }
        }
        result.set(routine.slug, { consecutiveFailures: Number(row?.consecutive_failures ?? 0), autoDisabledAt, lastOutcome })
    }
    return result
}
