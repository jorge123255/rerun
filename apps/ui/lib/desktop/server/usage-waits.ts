import 'server-only'
import { randomUUID } from 'node:crypto'
import { desktopPlanWait, desktopUsageExpiredText, desktopUsagePark, isDesktopPlanProvider, type DesktopUsageParking } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { desktopConnections } from '../chat-model'
import { DesktopHttpError } from './auth'
import { resolveDesktopChatModel } from './chat-model'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { readDesktopProviders } from './settings'
import { findDesktopAgent, findDesktopSession, type DesktopAgent, type DesktopSession } from './store'
import { DesktopPlanOutHttpError, readDesktopBackupModel } from './usage-gate-model'

/**
 * "Send when it resets": one chat message per conversation, kept until its plan has usage again.
 *
 * The message is sent once. It is claimed in the database before it is handed to the chat, so a
 * crash in between leaves it held for the person to look at, never sent a second time. It goes to
 * the conversation's own plan, or to the backup model the owner picked; if the conversation now
 * points at a key billed per token, it is held instead of sent.
 */
export type DesktopUsageWaitState = 'waiting' | 'sending' | 'sent' | 'cancelled' | 'held'
export type DesktopUsageWaitView = { id: string; text: string; plan: string; resetsAt: string | null; nextCheckAt: string; state: DesktopUsageWaitState; reason: string | null; createdAt: string }
export type DesktopUsageWaitStatus = {
    /** The message queued for this conversation, or the last one that was held back. */
    wait: DesktopUsageWaitView | null
    /** The plan this conversation would wait for now. Null when it does not run on a monthly plan. */
    plan: { name: string; resetsAt: string | null } | null
    backupSet: boolean
}

type Row = DesktopUsageWaitView & { agentId: string; sessionId: string | null; connectionId: string; recheckSince: string | null }
const nullable = (value: unknown) => value === null || value === undefined ? null : String(value)
function rowOf(row: Record<string, unknown>): Row {
    return {
        id: String(row.id), agentId: String(row.agent_id), sessionId: nullable(row.session_id), text: String(row.text), connectionId: String(row.connection_id),
        plan: String(row.plan), createdAt: String(row.created_at), resetsAt: nullable(row.resets_at), nextCheckAt: String(row.next_check_at),
        recheckSince: nullable(row.recheck_since), state: String(row.state) as DesktopUsageWaitState, reason: nullable(row.reason),
    }
}
const viewOf = ({ id, text, plan, resetsAt, nextCheckAt, state, reason, createdAt }: Row): DesktopUsageWaitView => ({ id, text, plan, resetsAt, nextCheckAt, state, reason, createdAt })

const HELD_CLOSED = 'Rerun closed while this message was being sent. Check the conversation before sending it again.'
const HELD_PAID = 'This conversation now uses a model billed per token, so the message was not sent. Send it yourself if you want that.'
const HELD_GONE = 'This conversation is no longer available, so the message was not sent.'

// Messages this process is handing to the chat right now. A `sending` row that is not here was
// claimed by a run of the app that ended first.
const sending = new Set<string>()

async function target(runtime: DesktopRuntime, db: Client, agentId: string, sessionId: string | null): Promise<{ agent: DesktopAgent; session: DesktopSession | null }> {
    const agent = await findDesktopAgent(db, agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    const session = sessionId ? await findDesktopSession(db, sessionId) : null
    if (sessionId && (!session || session.agentId !== agent.id)) throw new DesktopHttpError(404, 'Conversation not found')
    return { agent, session }
}

type Outlook =
    | { kind: 'out'; connectionId: string; plan: string; resetsAt: string | null }
    | { kind: 'ready'; connectionId: string; plan: string; isPlan: boolean; unknown: boolean; viaBackup: boolean }

/** Where this conversation's next message would go, and whether its plan is certain to refuse it. */
async function outlook(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession | null): Promise<Outlook> {
    try {
        const found = await resolveDesktopChatModel(runtime, agent, session, undefined, { usageGate: true })
        const connection = desktopConnections((await readDesktopProviders(runtime)).connections).find(item => item.id === found.connectionId)
        return {
            kind: 'ready', connectionId: found.connectionId, plan: connection?.name ?? 'the plan', isPlan: isDesktopPlanProvider(connection?.provider), viaBackup: found.viaBackup === true,
            unknown: desktopPlanWait(connection?.planLimits, new Date()).state === 'unknown',
        }
    } catch (error) {
        if (!(error instanceof DesktopPlanOutHttpError)) throw error
        return { kind: 'out', connectionId: error.plan.connectionId, plan: error.plan.name, resetsAt: error.resetsAt }
    }
}

async function current(db: Client, agentId: string, sessionId: string | null): Promise<Row | null> {
    const row = (await db.execute({ sql: `SELECT * FROM desktop_usage_chat_waits WHERE agent_id=? AND COALESCE(session_id,'')=? AND state IN ('waiting','sending','held') ORDER BY created_at DESC LIMIT 1`, args: [agentId, sessionId ?? ''] })).rows[0]
    return row ? rowOf(row as Record<string, unknown>) : null
}

export async function readDesktopUsageWait(runtime: DesktopRuntime, agentId: string, sessionId: string | null): Promise<DesktopUsageWaitStatus> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const { agent, session } = await target(runtime, db, agentId, sessionId)
    const [wait, view, backup] = await Promise.all([current(db, agentId, sessionId), outlook(runtime, agent, session).catch(() => null), readDesktopBackupModel(runtime).catch(() => null)])
    const plan = !view ? null : view.kind === 'out' ? { name: view.plan, resetsAt: view.resetsAt } : view.isPlan && !view.viaBackup ? { name: view.plan, resetsAt: null } : null
    return { wait: wait ? viewOf(wait) : null, plan, backupSet: !!backup }
}

export type DesktopUsageWaitKey = { agentId: string; sessionId: string | null }
/** The conversations that hold a waiting or held-back message. The app shows and clocks only these. */
export async function listDesktopUsageWaitKeys(runtime: DesktopRuntime): Promise<DesktopUsageWaitKey[]> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    return (await db.execute(`SELECT DISTINCT agent_id,session_id FROM desktop_usage_chat_waits WHERE state IN ('waiting','sending','held')`)).rows
        .map(row => ({ agentId: String(row.agent_id), sessionId: nullable(row.session_id) }))
}

/** Queues exactly this message, once, for this conversation. A second request while one waits is refused. */
export async function queueDesktopUsageWait(runtime: DesktopRuntime, input: { agentId: string; sessionId: string | null; text: string }, now = new Date()): Promise<DesktopUsageWaitStatus> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const { agent, session } = await target(runtime, db, input.agentId, input.sessionId)
    const text = input.text.trim()
    if (!text) throw new DesktopHttpError(400, 'There is no message to send later.')
    const view = await outlook(runtime, agent, session)
    if (view.kind === 'ready' && (!view.isPlan || view.viaBackup)) throw new DesktopHttpError(409, 'This conversation is not waiting for a plan. Send the message now.')
    const parking = desktopUsagePark(now, view.kind === 'out' ? view.resetsAt : null) as DesktopUsageParking
    try {
        await db.execute({
            sql: `INSERT INTO desktop_usage_chat_waits(id,agent_id,session_id,text,connection_id,plan,created_at,resets_at,next_check_at,recheck_since,state) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting')`,
            args: [randomUUID(), agent.id, session?.id ?? null, text, view.connectionId, view.plan, now.toISOString(), parking.resetsAt, parking.nextCheckAt, parking.recheckSince],
        })
    } catch (error) {
        if (/UNIQUE|constraint/i.test(String(error))) throw new DesktopHttpError(409, 'A message is already waiting to be sent in this conversation.')
        throw error
    }
    // An older held notice is replaced by the new wait.
    await db.execute({ sql: `UPDATE desktop_usage_chat_waits SET state='cancelled',settled_at=? WHERE agent_id=? AND COALESCE(session_id,'')=? AND state='held'`, args: [now.toISOString(), agent.id, session?.id ?? ''] })
    return readDesktopUsageWait(runtime, input.agentId, input.sessionId)
}

/** Cancels a waiting message, or dismisses a held one. A message already being sent cannot be recalled. */
export async function cancelDesktopUsageWait(runtime: DesktopRuntime, id: string, now = new Date()): Promise<boolean> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const result = await db.execute({ sql: `UPDATE desktop_usage_chat_waits SET state='cancelled',settled_at=? WHERE id=? AND state IN ('waiting','held')`, args: [now.toISOString(), id] })
    return result.rowsAffected === 1
}

async function hold(db: Client, id: string, reason: string, now: Date, from: 'waiting' | 'sending' = 'waiting') {
    await db.execute({ sql: `UPDATE desktop_usage_chat_waits SET state='held',reason=?,settled_at=? WHERE id=? AND state=?`, args: [reason.slice(0, 500), now.toISOString(), id, from] })
}

async function wait(db: Client, row: Row, resetsAt: string | null, now: Date) {
    const parking = desktopUsagePark(now, resetsAt, { parkedAt: row.createdAt, resetsAt: row.resetsAt, nextCheckAt: row.nextCheckAt, recheckSince: row.recheckSince })
    if (parking === 'expired') return hold(db, row.id, desktopUsageExpiredText(row.plan), now)
    await db.execute({ sql: `UPDATE desktop_usage_chat_waits SET resets_at=?,next_check_at=?,recheck_since=? WHERE id=? AND state='waiting'`, args: [parking.resetsAt, parking.nextCheckAt, parking.recheckSince, row.id] })
}

export type DesktopUsageWaitSend = (runtime: DesktopRuntime, input: { agentId: string; sessionId?: string; text: string; requestId?: string }) => Promise<{ response: Response }>

/**
 * Sends every waiting message whose plan can answer now. Called on a timer by the open app.
 * Returns the ids it sent.
 */
export async function flushDesktopUsageWaits(runtime: DesktopRuntime, send: DesktopUsageWaitSend, now = new Date()): Promise<string[]> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const rows = (await db.execute(`SELECT * FROM desktop_usage_chat_waits WHERE state IN ('waiting','sending') ORDER BY created_at`)).rows.map(row => rowOf(row as Record<string, unknown>))
    const sent: string[] = []
    for (const row of rows) {
        if (row.state === 'sending') { if (!sending.has(row.id)) await hold(db, row.id, HELD_CLOSED, now, 'sending'); continue }
        if (Date.parse(row.nextCheckAt) > now.getTime()) {
            // Not time yet, unless the owner's backup model can take it now.
            if (!await readDesktopBackupModel(runtime).catch(() => null)) continue
        }
        let agent: DesktopAgent, session: DesktopSession | null
        try { ({ agent, session } = await target(runtime, db, row.agentId, row.sessionId)) }
        catch { await hold(db, row.id, HELD_GONE, now); continue }
        let view: Outlook
        try { view = await outlook(runtime, agent, session) }
        catch (error) { await hold(db, row.id, error instanceof DesktopHttpError ? error.message : 'The message could not be sent.', now); continue }
        if (view.kind === 'out') { if (Date.parse(row.nextCheckAt) <= now.getTime()) await wait(db, row, view.resetsAt, now); continue }
        if (!view.viaBackup) {
            if (Date.parse(row.nextCheckAt) > now.getTime()) continue
            // Nothing moves to a key billed per token on its own. Another monthly plan is the owner's own change of model.
            if (!view.isPlan) { await hold(db, row.id, HELD_PAID, now); continue }
            // A window that reads full with no reset time: look again later rather than spend the one send.
            if (view.connectionId === row.connectionId && view.unknown) { await wait(db, row, null, now); continue }
        }
        const claimed = await db.execute({ sql: `UPDATE desktop_usage_chat_waits SET state='sending' WHERE id=? AND state='waiting'`, args: [row.id] })
        if (claimed.rowsAffected !== 1) continue
        sending.add(row.id)
        try {
            const { response } = await send(runtime, { agentId: agent.id, ...(session && { sessionId: session.id, requestId: row.id }), text: row.text })
            if (!response.ok) {
                const body = await response.json().catch(() => null) as { error?: unknown } | null
                await hold(db, row.id, typeof body?.error === 'string' ? body.error : 'The message could not be sent.', now, 'sending')
                continue
            }
            await db.execute({ sql: `UPDATE desktop_usage_chat_waits SET state='sent',settled_at=? WHERE id=? AND state='sending'`, args: [now.toISOString(), row.id] })
            sent.push(row.id)
            // The reply streams to whoever opens the conversation; here it only has to be read to the end.
            void response.body?.pipeTo(new WritableStream()).catch(() => {})
        } catch (error) {
            await hold(db, row.id, error instanceof DesktopHttpError ? error.message : 'The message could not be sent.', now, 'sending')
        } finally { sending.delete(row.id) }
    }
    return sent
}
