import { getSystemDb } from '../db/systemDb.js'
import type { Schedule } from '../schedules/loader.js'

// Root registers this additive schema in each local coworker's system DB before enabling schedules.
export const desktopScheduleOccurrenceSchema = `CREATE TABLE IF NOT EXISTS desktop_schedule_occurrences (
 schedule_slug TEXT NOT NULL, occurrence TEXT NOT NULL, claimed_at TEXT NOT NULL,
 session_id TEXT, run_id TEXT, state TEXT NOT NULL DEFAULT 'claimed',
 PRIMARY KEY(schedule_slug,occurrence));
CREATE UNIQUE INDEX IF NOT EXISTS desktop_schedule_one_active ON desktop_schedule_occurrences(schedule_slug) WHERE state IN ('claimed','started');`
export async function claimDesktopSchedule(agentId:string,schedule:Schedule,manualId?:string):Promise<boolean> {
    const {client}=await getSystemDb(agentId)
    // A due occurrence is the baseline consumed by markFired. Resume consumes only one baseline,
    // then markFired moves directly to now, so missed intervals are never replayed.
    const occurrence=manualId ? `manual:${manualId}` : `due:${schedule.lastRunAt ?? schedule.createdAt}`
    const result=await client.execute({sql:`INSERT INTO desktop_schedule_occurrences(schedule_slug,occurrence,claimed_at) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM desktop_schedule_occurrences WHERE schedule_slug=? AND state IN ('claimed','started')) ON CONFLICT DO NOTHING`,args:[schedule.slug,occurrence,new Date().toISOString(),schedule.slug]})
    return result.rowsAffected===1
}
export async function recordDesktopSchedule(agentId:string,schedule:Schedule,manualId:string|undefined,sessionId:string,runId:string) {
    const {client}=await getSystemDb(agentId)
    const occurrence=manualId ? `manual:${manualId}` : `due:${schedule.lastRunAt ?? schedule.createdAt}`
    await client.execute({sql:"UPDATE desktop_schedule_occurrences SET session_id=?,run_id=?,state=CASE WHEN state='claimed' THEN 'started' ELSE state END WHERE schedule_slug=? AND occurrence=?",args:[sessionId,runId,schedule.slug,occurrence]})
}

export async function finishDesktopSchedule(agentId:string,schedule:Schedule,manualId?:string) {
    const {client}=await getSystemDb(agentId)
    const occurrence=manualId ? `manual:${manualId}` : `due:${schedule.lastRunAt ?? schedule.createdAt}`
    await client.execute({sql:"UPDATE desktop_schedule_occurrences SET state='settled' WHERE schedule_slug=? AND occurrence=?",args:[schedule.slug,occurrence]})
}
/** Root calls only during single-owner startup AFTER reconcileInterruptedRuns, before admissions. */
export async function recoverDesktopScheduleClaims(agentId:string) {
    const {client}=await getSystemDb(agentId)
    await client.execute("UPDATE desktop_schedule_occurrences SET state='interrupted' WHERE state IN ('claimed','started')")
}

/** Agent-specific DB plus explicit run/session ownership checks; never relaunch an incomplete receipt. */
export async function replayDesktopSchedule(agentId:string,slug:string,manualId:string) {
    const {client}=await getSystemDb(agentId)
    const row=(await client.execute({sql:'SELECT * FROM desktop_schedule_occurrences WHERE schedule_slug=? AND occurrence=?',args:[slug,`manual:${manualId}`]})).rows[0]
    if(!row)return null
    if(!row.session_id || !row.run_id)throw new Error('Manual request already claimed; result unavailable (reconciliation required)')
    const {getRun}=await import('../db/repos/runs.js')
    const {getSession}=await import('../db/repos/sessions.js')
    const [run,session]=await Promise.all([getRun(agentId,String(row.run_id)),getSession(agentId,String(row.session_id))])
    if(!run || !session || run.agentId!==agentId || session.agentId!==agentId || run.sessionId!==session.id || run.triggerSource!=='schedule' || run.triggerSlug!==slug || session.source!=='schedule')throw new Error('Manual receipt ownership mismatch')
    return {runId:run.id,sessionId:session.id}
}
