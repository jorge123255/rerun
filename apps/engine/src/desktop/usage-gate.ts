import { DESKTOP_USAGE_STILL_WAITING, MODEL_NOT_IN_PLAN, desktopPlanWait, desktopUsageExpiredText, desktopUsagePark, desktopUsageWaitText, isDesktopPlanProvider, type DesktopRoutineUsageSkip, type DesktopRoutineUsageWait } from '@rerun/contracts'
import { readPlanLimits } from '../connections/plan-limits.js'
import { getSystemDb } from '../db/systemDb.js'

/**
 * Routines wait for a plan that ran out, instead of failing (Mac app).
 *
 * A routine whose plan is out of usage is parked: one row per routine in the coworker's own
 * database, so it survives a restart. The scheduler looks at the rows on every tick and runs the
 * routine again when the plan's window has reset. With no reset time it tries every 15 minutes for
 * at most 24 hours, then records the occurrence as skipped with a plain reason.
 *
 * A parked occurrence is never a failed run: before the start there is no run at all, and a run
 * the provider refused for usage is stored as stopped, with a note in its conversation.
 */
export const desktopUsageGateSchema = `CREATE TABLE IF NOT EXISTS desktop_schedule_usage_waits (
 schedule_slug TEXT PRIMARY KEY, connection_id TEXT NOT NULL, plan TEXT NOT NULL,
 parked_at TEXT NOT NULL, resets_at TEXT, next_check_at TEXT NOT NULL, recheck_since TEXT,
 state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','running')),
 try_backup INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS desktop_schedule_usage_skips (
 schedule_slug TEXT PRIMARY KEY, at TEXT NOT NULL, reason TEXT NOT NULL);`

export type UsageWait = DesktopRoutineUsageWait & { connectionId: string; recheckSince: string | null; state: 'waiting' | 'running'; tryBackup: boolean }
/** Who a gated routine run answers to: the plan it was started on. */
export type UsageGateTarget = { connectionId: string; plan: string; provider: string }

/** Thrown out of a launch that parked or skipped instead of starting. Not a failure. */
export class UsageWaitError extends Error {
    constructor(message: string) { super(message); this.name = 'UsageWaitError' }
}

/** The app's answer when a Rerun preset has no plan with usage left. */
export class DesktopPlanOutError extends Error {
    constructor(message: string, readonly target: UsageGateTarget, readonly resetsAt: string | null) { super(message); this.name = 'DesktopPlanOutError' }
}

const text = (value: unknown) => value === null || value === undefined ? null : String(value)
function waitOf(row: Record<string, unknown>): UsageWait {
    return {
        slug: String(row.schedule_slug), connectionId: String(row.connection_id), plan: String(row.plan), parkedAt: String(row.parked_at),
        resetsAt: text(row.resets_at), nextCheckAt: String(row.next_check_at), recheckSince: text(row.recheck_since),
        state: row.state === 'running' ? 'running' : 'waiting', tryBackup: Number(row.try_backup) === 1, skippedWhileWaiting: Number(row.skipped),
    }
}

/** Called once per coworker at startup. A run that was resumed when the app quit is not run twice. */
export async function initializeUsageGate(agentId: string): Promise<void> {
    const { client } = await getSystemDb(agentId)
    await client.executeMultiple(`${desktopUsageGateSchema}\nDELETE FROM desktop_schedule_usage_waits WHERE state='running';`)
}

// A coworker created after startup has no table until its first routine is authorized.
const missing = (error: unknown) => /no such table/i.test(String(error))

export async function listUsageWaits(agentId: string): Promise<UsageWait[]> {
    try {
        const { client } = await getSystemDb(agentId)
        return (await client.execute('SELECT * FROM desktop_schedule_usage_waits')).rows.map(row => waitOf(row as Record<string, unknown>))
    } catch (error) { if (missing(error)) return []; throw error }
}

export async function readUsageWait(agentId: string, slug: string): Promise<UsageWait | null> {
    return (await listUsageWaits(agentId)).find(wait => wait.slug === slug) ?? null
}

export async function listUsageSkips(agentId: string): Promise<DesktopRoutineUsageSkip[]> {
    try {
        const { client } = await getSystemDb(agentId)
        return (await client.execute('SELECT * FROM desktop_schedule_usage_skips')).rows.map(row => ({ slug: String(row.schedule_slug), at: String(row.at), reason: String(row.reason) }))
    } catch (error) { if (missing(error)) return []; throw error }
}

async function recordSkip(agentId: string, slug: string, reason: string, now: Date): Promise<void> {
    const { client } = await getSystemDb(agentId)
    await client.batch([
        { sql: 'DELETE FROM desktop_schedule_usage_waits WHERE schedule_slug=?', args: [slug] },
        { sql: 'INSERT INTO desktop_schedule_usage_skips(schedule_slug,at,reason) VALUES(?,?,?) ON CONFLICT(schedule_slug) DO UPDATE SET at=excluded.at,reason=excluded.reason', args: [slug, now.toISOString(), reason] },
    ], 'write')
}

export type ParkResult = { kind: 'parked'; text: string; wait: UsageWait } | { kind: 'skipped'; text: string }

/**
 * Parks the routine, or keeps it parked, until the plan can answer. At most one row per routine.
 * `tryBackup` asks the next tick to see whether the owner's backup model can run it meanwhile.
 */
export async function parkSchedule(agentId: string, slug: string, target: Pick<UsageGateTarget, 'connectionId' | 'plan'>, resetsAt: string | null, now: Date, tryBackup = false): Promise<ParkResult> {
    const prior = await readUsageWait(agentId, slug)
    const parking = desktopUsagePark(now, resetsAt, prior)
    if (parking === 'expired') {
        const reason = desktopUsageExpiredText(target.plan)
        await recordSkip(agentId, slug, reason, now)
        return { kind: 'skipped', text: reason }
    }
    const { client } = await getSystemDb(agentId)
    await client.execute({
        sql: `INSERT INTO desktop_schedule_usage_waits(schedule_slug,connection_id,plan,parked_at,resets_at,next_check_at,recheck_since,state,try_backup,skipped) VALUES(?,?,?,?,?,?,?,'waiting',?,0)
            ON CONFLICT(schedule_slug) DO UPDATE SET connection_id=excluded.connection_id,plan=excluded.plan,resets_at=excluded.resets_at,next_check_at=excluded.next_check_at,
            recheck_since=excluded.recheck_since,state='waiting',try_backup=excluded.try_backup`,
        args: [slug, target.connectionId, target.plan, parking.parkedAt, parking.resetsAt, parking.nextCheckAt, parking.recheckSince, tryBackup ? 1 : 0],
    })
    const wait = (await readUsageWait(agentId, slug))!
    return { kind: 'parked', text: desktopUsageWaitText(target.plan, parking.resetsAt), wait }
}

/** A later firing while the routine is parked replaces nothing: it is counted and skipped. */
export async function noteStillWaiting(agentId: string, slug: string): Promise<string> {
    const { client } = await getSystemDb(agentId)
    await client.execute({ sql: 'UPDATE desktop_schedule_usage_waits SET skipped=skipped+1 WHERE schedule_slug=?', args: [slug] })
    return DESKTOP_USAGE_STILL_WAITING
}

export async function clearUsageWait(agentId: string, slug: string): Promise<void> {
    try {
        const { client } = await getSystemDb(agentId)
        await client.execute({ sql: 'DELETE FROM desktop_schedule_usage_waits WHERE schedule_slug=?', args: [slug] })
    } catch (error) { if (!missing(error)) throw error }
}

/** The resumed run is starting: the row stays, so a second refusal keeps the first waiting time. */
export async function markUsageWaitRunning(agentId: string, slug: string): Promise<void> {
    const { client } = await getSystemDb(agentId)
    await client.batch([
        { sql: "UPDATE desktop_schedule_usage_waits SET state='running',try_backup=0 WHERE schedule_slug=?", args: [slug] },
        { sql: 'DELETE FROM desktop_schedule_usage_skips WHERE schedule_slug=?', args: [slug] },
    ], 'write')
}

/** The run is over. A row still `running` was not parked again, so the wait is finished. */
export async function settleUsageWait(agentId: string, slug: string): Promise<void> {
    try {
        const { client } = await getSystemDb(agentId)
        await client.execute({ sql: "DELETE FROM desktop_schedule_usage_waits WHERE schedule_slug=? AND state='running'", args: [slug] })
    } catch (error) { if (!missing(error)) throw error }
}

export function usageWaitDue(wait: UsageWait, now: Date): boolean {
    return wait.state === 'waiting' && (wait.tryBackup || Date.parse(wait.nextCheckAt) <= now.getTime())
}

export type StartGate = { kind: 'run' } | { kind: 'backup'; override: { connectionId: string; provider: string; model: string }; note: string } | ParkResult

/**
 * Decides, just before a routine starts, whether its plan can answer.
 *
 * Only a reading that is certain blocks a start: a full window whose reset is still ahead. A full
 * window with no reset time is tried, because for some plans only a run brings a new reading.
 * `backup` asks the app for the owner's backup model; it is the only other model ever used.
 */
export async function gateScheduledStart(input: {
    agentId: string; slug: string; target: UsageGateTarget | null; now: Date
    backup: (target: UsageGateTarget) => Promise<{ override: { connectionId: string; provider: string; model: string }; note: string } | null>
}): Promise<StartGate> {
    const { agentId, slug, target, now } = input
    if (!target || !isDesktopPlanProvider(target.provider)) return { kind: 'run' }
    const wait = await readUsageWait(agentId, slug)
    const reading = desktopPlanWait(readPlanLimits(target.connectionId), now)
    // Resumed early, only to ask about the backup: the plan is still held to its own time.
    const early = !!wait && wait.connectionId === target.connectionId && Date.parse(wait.nextCheckAt) > now.getTime()
    if (reading.state !== 'waiting' && !early) return { kind: 'run' }
    const backup = await input.backup(target)
    if (backup) return { kind: 'backup', ...backup }
    if (early && reading.state !== 'waiting') {
        const { client } = await getSystemDb(agentId)
        await client.execute({ sql: 'UPDATE desktop_schedule_usage_waits SET try_backup=0 WHERE schedule_slug=?', args: [slug] })
        return { kind: 'parked', text: desktopUsageWaitText(wait.plan, wait.resetsAt), wait }
    }
    return parkSchedule(agentId, slug, target, reading.resetsAt, now)
}

/**
 * A routine run the provider refused for usage. Returns the line to leave in its conversation when
 * the run is parked or skipped, or null when this is an ordinary failure: a model the plan does not
 * include never comes back by waiting, and a key billed per token has no window to wait for.
 */
export async function parkRefusedScheduledRun(input: { agentId: string; slug: string; target: UsageGateTarget; error: string; now?: Date }): Promise<string | null> {
    if (!isDesktopPlanProvider(input.target.provider) || MODEL_NOT_IN_PLAN.test(input.error)) return null
    const now = input.now ?? new Date()
    const reading = desktopPlanWait(readPlanLimits(input.target.connectionId), now)
    const result = await parkSchedule(input.agentId, input.slug, input.target, reading.resetsAt, now, true)
    return `${result.text}.`.replace(/\.\.$/, '.')
}
