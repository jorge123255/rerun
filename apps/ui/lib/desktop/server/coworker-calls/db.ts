import 'server-only'
import {
    DESKTOP_COWORKER_CALL_INTERRUPTED_REASON,
    DESKTOP_COWORKER_CALL_MAX_FANOUT,
    desktopCoworkerCallProgressSchema,
    desktopCoworkerCallStatuses,
    type DesktopCoworkerCallProgress,
    type DesktopCoworkerCallStatus,
} from '@rerun/contracts'
import type { Client, InValue } from '@libsql/client'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'

const ACTIVE: readonly DesktopCoworkerCallStatus[] = ['queued', 'running', 'dispatched', 'waiting-human']
const phaseSchema = z.enum(['reserved', 'session-open', 'launched', 'terminal'])
const id = z.string().trim().min(1).max(256)

export const coworkerCallRowSchema = z.strictObject({
    callId: z.string().uuid(),
    revision: z.number().int().positive(),
    sourceKey: z.string().min(1).max(2_000),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    parentAgentId: id,
    parentSessionId: id,
    parentRunId: id,
    toolCallId: id,
    targetAgentId: id,
    targetSessionId: id.nullable(),
    targetName: z.string().trim().min(1).max(200),
    wait: z.boolean(),
    status: z.enum(desktopCoworkerCallStatuses),
    phase: phaseSchema,
    launchEpoch: z.string().min(1).max(80),
    launchClaimed: z.boolean(),
    engineParentAgentId: id,
    engineParentSessionId: id,
    engineParentRunId: id,
    engineTargetAgentId: id,
    engineTargetSessionId: id.nullable(),
    engineChildRunId: id.nullable(),
    depth: z.number().int().nonnegative(),
    ancestors: z.array(id).max(8),
    progress: desktopCoworkerCallProgressSchema,
    pendingToolCallId: id.nullable(),
    resultText: z.string().nullable(),
    error: z.string().nullable(),
    stopRequestId: z.string().uuid().nullable(),
    createdAt: z.string().min(1).max(40),
    updatedAt: z.string().min(1).max(40),
})
export type CoworkerCallRecord = z.infer<typeof coworkerCallRowSchema>

export type CoworkerCallPatch = Partial<Pick<CoworkerCallRecord, 'targetSessionId' | 'status' | 'phase' | 'engineTargetSessionId' | 'engineChildRunId' | 'progress' | 'resultText' | 'error' | 'stopRequestId' | 'launchClaimed' | 'pendingToolCallId'>>
export type CoworkerCallExpect = { revision?: number; statuses?: readonly DesktopCoworkerCallStatus[]; engineChildRunId?: string | null; stopUnclaimed?: boolean; stopRequestId?: string | null }

type Reader = Pick<Client, 'execute'>

export async function initializeDesktopCoworkerCalls(db: Client): Promise<void> {
    await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS desktop_coworker_calls (
            call_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            source_key TEXT NOT NULL UNIQUE,
            request_fingerprint TEXT NOT NULL,
            parent_agent_id TEXT NOT NULL,
            parent_session_id TEXT NOT NULL,
            parent_run_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            target_agent_id TEXT NOT NULL,
            target_session_id TEXT,
            target_name TEXT NOT NULL,
            wait INTEGER NOT NULL CHECK (wait IN (0, 1)),
            status TEXT NOT NULL,
            phase TEXT NOT NULL,
            launch_epoch TEXT NOT NULL,
            launch_claimed INTEGER NOT NULL CHECK (launch_claimed IN (0, 1)),
            engine_parent_agent_id TEXT NOT NULL,
            engine_parent_session_id TEXT NOT NULL,
            engine_parent_run_id TEXT NOT NULL,
            engine_target_agent_id TEXT NOT NULL,
            engine_target_session_id TEXT,
            engine_child_run_id TEXT,
            depth INTEGER NOT NULL,
            ancestors_json TEXT NOT NULL,
            progress_json TEXT NOT NULL,
            pending_tool_call_id TEXT,
            result_text TEXT,
            error TEXT,
            stop_request_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS desktop_coworker_calls_parent ON desktop_coworker_calls(parent_session_id);
        CREATE INDEX IF NOT EXISTS desktop_coworker_calls_child_run ON desktop_coworker_calls(engine_child_run_id);
        CREATE TABLE IF NOT EXISTS desktop_coworker_call_epoch (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            epoch TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_coworker_call_retired_launches (launch_nonce TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS desktop_coworker_call_launch (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            launch_nonce TEXT NOT NULL,
            epoch TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_coworker_call_stops (
            request_id TEXT PRIMARY KEY,
            call_id TEXT NOT NULL,
            expected_revision TEXT NOT NULL,
            http_status INTEGER NOT NULL,
            body_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_coworker_call_stop_intents (
            request_id TEXT PRIMARY KEY,
            call_id TEXT NOT NULL,
            parent_session_id TEXT NOT NULL,
            expected_revision TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_coworker_call_allows (
            caller_agent_id TEXT NOT NULL,
            target_agent_id TEXT NOT NULL,
            PRIMARY KEY (caller_agent_id, target_agent_id)
        );
    `)
}

function recordOf(row: Record<string, unknown>): CoworkerCallRecord {
    return coworkerCallRowSchema.parse({
        callId: String(row.call_id),
        revision: Number(row.revision),
        sourceKey: String(row.source_key),
        requestFingerprint: String(row.request_fingerprint),
        parentAgentId: String(row.parent_agent_id),
        parentSessionId: String(row.parent_session_id),
        parentRunId: String(row.parent_run_id),
        toolCallId: String(row.tool_call_id),
        targetAgentId: String(row.target_agent_id),
        targetSessionId: row.target_session_id == null ? null : String(row.target_session_id),
        targetName: String(row.target_name),
        wait: Number(row.wait) === 1,
        status: String(row.status),
        phase: String(row.phase),
        launchEpoch: String(row.launch_epoch),
        launchClaimed: Number(row.launch_claimed) === 1,
        engineParentAgentId: String(row.engine_parent_agent_id),
        engineParentSessionId: String(row.engine_parent_session_id),
        engineParentRunId: String(row.engine_parent_run_id),
        engineTargetAgentId: String(row.engine_target_agent_id),
        engineTargetSessionId: row.engine_target_session_id == null ? null : String(row.engine_target_session_id),
        engineChildRunId: row.engine_child_run_id == null ? null : String(row.engine_child_run_id),
        depth: Number(row.depth),
        ancestors: JSON.parse(String(row.ancestors_json)),
        progress: JSON.parse(String(row.progress_json)),
        pendingToolCallId: row.pending_tool_call_id == null ? null : String(row.pending_tool_call_id),
        resultText: row.result_text == null ? null : String(row.result_text),
        error: row.error == null ? null : String(row.error),
        stopRequestId: row.stop_request_id == null ? null : String(row.stop_request_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    })
}

const SELECT = `SELECT call_id, revision, source_key, request_fingerprint, parent_agent_id, parent_session_id, parent_run_id, tool_call_id,
    target_agent_id, target_session_id, target_name, wait, status, phase, launch_epoch, launch_claimed,
    engine_parent_agent_id, engine_parent_session_id, engine_parent_run_id, engine_target_agent_id,
    engine_target_session_id, engine_child_run_id, depth, ancestors_json, progress_json, pending_tool_call_id, result_text, error,
    stop_request_id, created_at, updated_at FROM desktop_coworker_calls`

async function one(db: Reader, sql: string, args: InValue[]): Promise<CoworkerCallRecord | null> {
    const result = await db.execute({ sql, args })
    return result.rows[0] ? recordOf(result.rows[0] as Record<string, unknown>) : null
}

function argsOf(row: CoworkerCallRecord): InValue[] {
    return [row.callId, row.revision, row.sourceKey, row.requestFingerprint, row.parentAgentId, row.parentSessionId, row.parentRunId, row.toolCallId,
        row.targetAgentId, row.targetSessionId, row.targetName, row.wait ? 1 : 0, row.status, row.phase, row.launchEpoch, row.launchClaimed ? 1 : 0,
        row.engineParentAgentId, row.engineParentSessionId, row.engineParentRunId, row.engineTargetAgentId, row.engineTargetSessionId,
        row.engineChildRunId, row.depth, JSON.stringify(row.ancestors), JSON.stringify(row.progress), row.pendingToolCallId, row.resultText, row.error,
        row.stopRequestId, row.createdAt, row.updatedAt]
}

function matches(row: CoworkerCallRecord, expect: CoworkerCallExpect): boolean {
    if (expect.revision !== undefined && row.revision !== expect.revision) return false
    if (expect.statuses && !expect.statuses.includes(row.status)) return false
    if (expect.engineChildRunId !== undefined && row.engineChildRunId !== expect.engineChildRunId) return false
    if (expect.stopUnclaimed && row.stopRequestId) return false
    if (expect.stopRequestId !== undefined && row.stopRequestId !== expect.stopRequestId) return false
    return true
}

function apply(row: CoworkerCallRecord, patch: CoworkerCallPatch, now: string): CoworkerCallRecord {
    const statusChanged = patch.status !== undefined && patch.status !== row.status
    return coworkerCallRowSchema.parse({
        ...row,
        ...patch,
        progress: patch.progress ?? row.progress,
        revision: row.revision + (statusChanged ? 1 : 0),
        updatedAt: now,
    })
}

export async function adoptDesktopCoworkerCallEpoch(db: Client, epoch: string, now: string, launchNonce?: string): Promise<void> {
    const tx = await db.transaction('write')
    try {
        if (launchNonce) {
            if ((await tx.execute({ sql: 'SELECT launch_nonce FROM desktop_coworker_call_retired_launches WHERE launch_nonce=?', args: [launchNonce] })).rows.length) throw new DesktopHttpError(409, 'The coworker call runtime has changed.')
            const launch = (await tx.execute('SELECT launch_nonce, epoch FROM desktop_coworker_call_launch WHERE id=1')).rows[0]
            if (launch?.launch_nonce === launchNonce && launch.epoch !== epoch) throw new DesktopHttpError(409, 'The coworker call runtime was already bound for this app launch.')
            if (launch && launch.launch_nonce !== launchNonce) await tx.execute({ sql: 'INSERT OR IGNORE INTO desktop_coworker_call_retired_launches(launch_nonce) VALUES(?)', args: [String(launch.launch_nonce)] })
            await tx.execute({ sql: 'INSERT INTO desktop_coworker_call_launch(id,launch_nonce,epoch) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET launch_nonce=excluded.launch_nonce,epoch=excluded.epoch', args: [launchNonce, epoch] })
        }
        const current = await tx.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id = 1')
        const previous = current.rows[0] ? String(current.rows[0].epoch) : ''
        if (previous && previous !== epoch) {
            await tx.execute({
                sql: `UPDATE desktop_coworker_calls SET status = 'interrupted', phase = 'terminal', revision = revision + 1,
                    error = ?, updated_at = ? WHERE status IN ('queued', 'running', 'dispatched', 'waiting-human') AND phase != 'terminal' AND launch_epoch != ?`,
                args: [DESKTOP_COWORKER_CALL_INTERRUPTED_REASON, now, epoch],
            })
        }
        await tx.execute({ sql: `INSERT INTO desktop_coworker_call_epoch (id, epoch) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch`, args: [epoch] })
        await tx.commit()
    } finally { tx.close() }
}

export async function getDesktopCoworkerCallBySource(db: Reader, sourceKey: string): Promise<CoworkerCallRecord | null> {
    return one(db, `${SELECT} WHERE source_key = ?`, [sourceKey])
}

export async function getDesktopCoworkerCall(db: Reader, callId: string): Promise<CoworkerCallRecord | null> {
    return one(db, `${SELECT} WHERE call_id = ?`, [callId])
}

export async function listDesktopCoworkerCallRows(db: Reader, parentSessionId: string): Promise<CoworkerCallRecord[]> {
    const result = await db.execute({ sql: `${SELECT} WHERE parent_session_id = ? ORDER BY created_at DESC, call_id`, args: [parentSessionId] })
    return result.rows.map(row => recordOf(row as Record<string, unknown>))
}

export async function inboundDesktopCoworkerCall(db: Reader, engineRunId: string): Promise<CoworkerCallRecord | null> {
    return one(db, `${SELECT} WHERE engine_child_run_id = ?`, [engineRunId])
}

export async function insertDesktopCoworkerCall(db: Client, row: CoworkerCallRecord): Promise<{ inserted: true; row: CoworkerCallRecord } | { inserted: false; reason: 'exists' | 'fanout'; row: CoworkerCallRecord | null }> {
    const parsed = coworkerCallRowSchema.parse(row)
    const tx = await db.transaction('write')
    try {
        const epoch = (await tx.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id=1')).rows[0]?.epoch
        if (epoch !== parsed.launchEpoch) throw new DesktopHttpError(409, 'The coworker call runtime has changed.')
        const existing = await one(tx, `${SELECT} WHERE source_key = ?`, [parsed.sourceKey])
        if (existing) {
            if (existing.requestFingerprint !== parsed.requestFingerprint) throw new DesktopHttpError(409, 'This coworker call request changed.')
            await tx.commit(); return { inserted: false, reason: 'exists', row: existing }
        }
        const count = await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_coworker_calls WHERE engine_parent_run_id = ?', args: [parsed.engineParentRunId] })
        if (Number(count.rows[0]?.n ?? 0) >= DESKTOP_COWORKER_CALL_MAX_FANOUT) { await tx.commit(); return { inserted: false, reason: 'fanout', row: null } }
        const sibling = await one(tx, `${SELECT} WHERE engine_parent_run_id = ? LIMIT 1`, [parsed.engineParentRunId])
        const stored = sibling ? { ...parsed, parentRunId: sibling.parentRunId } : parsed
        await tx.execute({
            sql: `INSERT INTO desktop_coworker_calls (call_id, revision, source_key, request_fingerprint, parent_agent_id, parent_session_id, parent_run_id, tool_call_id,
                target_agent_id, target_session_id, target_name, wait, status, phase, launch_epoch, launch_claimed,
                engine_parent_agent_id, engine_parent_session_id, engine_parent_run_id, engine_target_agent_id,
                engine_target_session_id, engine_child_run_id, depth, ancestors_json, progress_json, pending_tool_call_id, result_text, error,
                stop_request_id, created_at, updated_at) VALUES (${Array.from({ length: 31 }, () => '?').join(',')})`,
            args: argsOf(stored),
        })
        await tx.commit()
        return { inserted: true, row: stored }
    } finally { tx.close() }
}

export async function claimDesktopCoworkerCall(db: Client, callId: string, epoch: string, now: string): Promise<CoworkerCallRecord | null> {
    const tx = await db.transaction('write')
    try {
        const result = await tx.execute({
            sql: `UPDATE desktop_coworker_calls SET launch_claimed = 1, updated_at = ?
                WHERE call_id = ? AND launch_claimed = 0 AND phase = 'reserved' AND status = 'queued' AND launch_epoch = ? AND EXISTS(SELECT 1 FROM desktop_coworker_call_epoch WHERE id=1 AND epoch=?)`,
            args: [now, callId, epoch, epoch],
        })
        const row = result.rowsAffected === 1 ? await one(tx, `${SELECT} WHERE call_id = ?`, [callId]) : null
        await tx.commit()
        return row
    } finally { tx.close() }
}

export async function patchDesktopCoworkerCall(db: Client, callId: string, expect: CoworkerCallExpect, patch: CoworkerCallPatch, now: string, expectedEpoch?: string): Promise<CoworkerCallRecord | null> {
    const tx = await db.transaction('write')
    try {
        const current = await one(tx, `${SELECT} WHERE call_id = ?`, [callId])
        const epoch = (await tx.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id=1')).rows[0]?.epoch
        if (!current || current.launchEpoch !== epoch || (expectedEpoch !== undefined && epoch !== expectedEpoch) || !matches(current, expect)) { await tx.commit(); return null }
        const next = apply(current, patch, now)
        await tx.execute({
            sql: `UPDATE desktop_coworker_calls SET revision=?, target_session_id=?, status=?, phase=?, engine_target_session_id=?,
                engine_child_run_id=?, progress_json=?, pending_tool_call_id=?, result_text=?, error=?, stop_request_id=?, launch_claimed=?, updated_at=? WHERE call_id=?`,
            args: [next.revision, next.targetSessionId, next.status, next.phase, next.engineTargetSessionId, next.engineChildRunId,
                JSON.stringify(next.progress satisfies DesktopCoworkerCallProgress), next.pendingToolCallId, next.resultText, next.error, next.stopRequestId, next.launchClaimed ? 1 : 0, next.updatedAt, next.callId],
        })
        await tx.commit()
        return next
    } finally { tx.close() }
}

export async function reserveDesktopCoworkerCallStop(db: Client, input: { requestId: string; callId: string; parentAgentId: string; parentSessionId: string; expectedRevision: string }): Promise<void> {
    const tx = await db.transaction('write')
    try {
        const call = await getDesktopCoworkerCall(tx, input.callId)
        if (!call || call.parentSessionId !== input.parentSessionId || call.parentAgentId !== input.parentAgentId) throw new DesktopHttpError(404, 'Coworker call not found.')
        const previous = (await tx.execute({ sql: 'SELECT * FROM desktop_coworker_call_stop_intents WHERE request_id = ?', args: [input.requestId] })).rows[0]
        if (previous && (previous.call_id !== input.callId || previous.parent_session_id !== input.parentSessionId || previous.expected_revision !== input.expectedRevision)) {
            throw new DesktopHttpError(409, 'That stop belongs to a different coworker call.')
        }
        const receipt = await readDesktopCoworkerCallStop(tx, input.requestId)
        if (receipt && (receipt.callId !== input.callId || receipt.expectedRevision !== input.expectedRevision)) throw new DesktopHttpError(409, 'That stop belongs to a different coworker call.')
        await tx.execute({ sql: 'INSERT INTO desktop_coworker_call_stop_intents (request_id, call_id, parent_session_id, expected_revision) VALUES (?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING', args: [input.requestId, input.callId, input.parentSessionId, input.expectedRevision] })
        await tx.commit()
    } finally { tx.close() }
}

export async function readDesktopCoworkerCallStop(db: Reader, requestId: string): Promise<{ callId: string; expectedRevision: string; httpStatus: number; body: unknown } | null> {
    const result = await db.execute({ sql: 'SELECT call_id, expected_revision, http_status, body_json FROM desktop_coworker_call_stops WHERE request_id = ?', args: [requestId] })
    const row = result.rows[0]
    if (!row) return null
    return { callId: String(row.call_id), expectedRevision: String(row.expected_revision), httpStatus: Number(row.http_status), body: JSON.parse(String(row.body_json)) }
}

export async function saveDesktopCoworkerCallStop(db: Client, receipt: { requestId: string; callId: string; expectedRevision: string; httpStatus: number; body: unknown }): Promise<void> {
    await db.execute({
        sql: `INSERT INTO desktop_coworker_call_stops (request_id, call_id, expected_revision, http_status, body_json) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(request_id) DO NOTHING`,
        args: [receipt.requestId, receipt.callId, receipt.expectedRevision, receipt.httpStatus, JSON.stringify(receipt.body)],
    })
}

export { ACTIVE as DESKTOP_COWORKER_CALL_ACTIVE }
