import 'server-only'
import { coworkerRuleOf, normalizeNotificationPrefs, type NotificationPrefs } from '@rerun/contracts'
import type { Client, Row } from '@libsql/client'
import { desktopNotifyUserNativeBody, desktopNotifyUserReceiptFromNative, type DesktopNotifyUserNativeResult, type DesktopNotifyUserReceipt } from '../../../../engine/src/desktop/notify-tools/contract'
import type { DesktopAttentionItem } from '../attention'
import type { DesktopNotificationAdmission, DesktopNotificationEvent, DesktopNotificationReceipt } from '../notifications'
import { getAgent, getRun } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { withRosterWrite } from './roster-writes'
import type { DesktopRuntime } from './runtime'
import { assertDesktopWorkspaceAdmission } from './workspace-admission'
import { engineOf } from './settings'

export const DESKTOP_USER_NOTIFICATION_WAIT_MS = 12_000

const USER_NOTIFICATIONS = `
CREATE TABLE IF NOT EXISTS desktop_user_notifications (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    attempt_id TEXT NOT NULL UNIQUE,
    workspace_id INTEGER NOT NULL,
    agent_engine_id TEXT NOT NULL,
    agent_local_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_engine_id TEXT NOT NULL,
    session_local_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    message TEXT NOT NULL,
    native_status TEXT CHECK (native_status IS NULL OR native_status IN ('shown', 'unavailable', 'failed', 'unknown')),
    reason TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_user_notifications_open_idx ON desktop_user_notifications(workspace_id, acknowledged_at, created_at);
`

export type DesktopNotifyGrant = 'granted' | 'revoked' | 'foreman' | 'child'
export type DesktopUserNotificationInput = {
    notificationId: string
    eventKey: string
    toolCallId: string
    agentId: string
    sessionId: string
    runId: string
    message: string
}
export type DesktopUserNotificationDeps = {
    grant: (agentId: string, signal: AbortSignal) => Promise<DesktopNotifyGrant>
    run: (input: DesktopUserNotificationInput, signal: AbortSignal) => Promise<boolean>
}

type Identity = Omit<DesktopNotifyUserReceipt, 'status' | 'nativeStatus' | 'reason'>
type Slot = {
    key: string
    attemptId: string
    identity: Identity
    event: DesktopNotificationEvent
    db: Client
    map: Map<string, Slot>
    handed: boolean
    claiming: boolean
    settled: boolean
    grant: () => Promise<boolean>
    confirm: () => Promise<boolean>
    resolve: (receipt: DesktopNotifyUserReceipt) => void
    promise: Promise<DesktopNotifyUserReceipt>
}
type Owner = { localAgentId: string; localSessionId: string; name: string; title: string; enabled: boolean; updatedAt: string }

const globalSlots = globalThis as typeof globalThis & { desktopUserNotificationSlots?: Map<string, Map<string, Slot>> }
function slotScopes() { return globalSlots.desktopUserNotificationSlots ??= new Map() }
function scopeKey(runtime: DesktopRuntime) { return JSON.stringify([runtime.workspaceId, runtime.launchNonce, runtime.dataRoot]) }
function scopeMap(runtime: DesktopRuntime) {
    const key = scopeKey(runtime)
    const scopes = slotScopes()
    let map = scopes.get(key)
    if (!map) scopes.set(key, map = new Map())
    return map
}
function findSlot(runtime: DesktopRuntime, key: string) { return slotScopes().get(scopeKey(runtime))?.get(key) }

const ensured = new WeakMap<Client, Promise<void>>()
export async function ensureDesktopUserNotifications(db: Client): Promise<void> {
    let ready = ensured.get(db)
    if (!ready) {
        ready = db.executeMultiple(USER_NOTIFICATIONS)
        ensured.set(db, ready)
        void ready.catch(() => { if (ensured.get(db) === ready) ensured.delete(db) })
    }
    return ready
}

export function classifyDesktopNotifyGrant(value: unknown): DesktopNotifyGrant {
    if (!value || typeof value !== 'object') return 'revoked'
    const config = value as { enabled?: unknown; kind?: unknown; ephemeral?: unknown; tools?: { desktopToolGrants?: { notify?: unknown } } }
    if (config.kind === 'foreman') return 'foreman'
    if (config.ephemeral === true) return 'child'
    if (config.enabled !== true || config.tools?.desktopToolGrants?.notify !== true) return 'revoked'
    return 'granted'
}

export function desktopInfoNotificationWanted(prefs: NotificationPrefs, agentId: string): boolean {
    if (prefs.scope === 'nothing') return false
    const rule = coworkerRuleOf(prefs, agentId)
    if (rule.mode === 'muted') return false
    if (rule.mode === 'everything') return true
    if (prefs.scope === 'needed') return false
    return prefs.scope === 'everything' || prefs.scope === 'mine'
}

export async function readDesktopNotifyGrant(runtime: DesktopRuntime, engineAgentId: string, signal: AbortSignal): Promise<DesktopNotifyGrant> {
    signal.throwIfAborted()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(engineAgentId)) return 'revoked'
    try {
        const agent = await getAgent(engineOf(runtime), engineAgentId, { signal })
        signal.throwIfAborted()
        return agent.id === engineAgentId ? classifyDesktopNotifyGrant(agent.config) : 'revoked'
    } catch { return 'revoked' }
}

export async function desktopNotifyRunIsCurrent(runtime: DesktopRuntime, input: DesktopUserNotificationInput, signal: AbortSignal): Promise<boolean> {
    try {
        const run = await getRun(engineOf(runtime), input.agentId, input.runId, { signal })
        return run.id === input.runId && run.agentId === input.agentId && run.sessionId === input.sessionId && run.status === 'running'
    } catch { return false }
}

function piece(value: string, max: number) {
    return value.length > 0 && value.length <= max && /^[A-Za-z0-9_.-]+$/.test(value)
}

function assertIdentity(input: DesktopUserNotificationInput) {
    if (!piece(input.agentId, 128) || !piece(input.sessionId, 128) || !piece(input.runId, 128) || !piece(input.toolCallId, 128) || !input.message.trim() || input.message.length > 16_000 || desktopNotifyUserNativeBody(input.message).trim() === '') {
        throw new DesktopHttpError(400, 'Notification identity is unavailable.')
    }
    const eventKey = `notify-user:${input.agentId}:${input.sessionId}:${input.runId}:${input.toolCallId}`
    const notificationId = `notify:${input.agentId}:${input.sessionId}:${input.runId}:${input.toolCallId}`
    if (input.eventKey !== eventKey || input.notificationId !== notificationId || eventKey.length > 600 || notificationId.length > 600) {
        throw new DesktopHttpError(400, 'Notification identity is unavailable.')
    }
}

async function ownerOf(db: Client, input: DesktopUserNotificationInput): Promise<Owner | null> {
    const rows = (await db.execute({
        sql: `SELECT a.id AS local_agent_id, a.name AS agent_name, a.enabled AS enabled, s.id AS local_session_id, s.title AS title, s.updated_at AS updated_at
              FROM desktop_agents a
              JOIN desktop_sessions s ON s.agent_id = a.id AND s.engine_session_id = ?
              LEFT JOIN desktop_deletions d ON d.agent_id = a.id
              WHERE a.engine_agent_id = ? AND a.workspace_id = 1 AND d.agent_id IS NULL`,
        args: [input.sessionId, input.agentId],
    })).rows
    if (rows.length !== 1) return null
    const row = rows[0]
    return {
        localAgentId: String(row.local_agent_id), localSessionId: String(row.local_session_id), name: String(row.agent_name),
        title: String(row.title), enabled: Number(row.enabled) !== 0, updatedAt: String(row.updated_at),
    }
}

async function readPrefs(db: Client): Promise<NotificationPrefs> {
    const row = (await db.execute('SELECT prefs FROM desktop_notification_prefs WHERE workspace_id = 1')).rows[0]
    let stored: unknown
    try { stored = row ? JSON.parse(String(row.prefs)) : undefined } catch { stored = undefined }
    return normalizeNotificationPrefs(stored)
}

function nativeOf(input: DesktopNotificationReceipt): DesktopNotifyUserNativeResult['status'] {
    if (input.nativeStatus === 'accepted') return 'shown'
    if (input.nativeStatus === 'shown' || input.nativeStatus === 'unavailable' || input.nativeStatus === 'failed' || input.nativeStatus === 'unknown') return input.nativeStatus
    return 'unknown'
}

function receiptFromRow(row: Row): DesktopNotifyUserReceipt {
    const native = row.native_status == null ? 'unknown' : String(row.native_status)
    const status = native === 'shown' || native === 'unavailable' || native === 'failed' || native === 'unknown' ? native : 'unknown'
    const receipt = desktopNotifyUserReceiptFromNative({
        notificationId: String(row.id), eventKey: String(row.event_key), attemptId: String(row.attempt_id),
        agentId: String(row.agent_engine_id), sessionId: String(row.session_engine_id), runId: String(row.run_id),
        message: String(row.message), metadata: null, createdAt: String(row.created_at),
    }, { status })
    const reason = row.reason == null ? undefined : String(row.reason).slice(0, 400)
    return reason && receipt.status !== 'accepted' ? { ...receipt, reason } : receipt
}

async function readStored(db: Client, eventKey: string): Promise<DesktopNotifyUserReceipt> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_user_notifications WHERE event_key = ?', args: [eventKey] })).rows[0]
    if (!row) throw new DesktopHttpError(404, 'The notification was not found.')
    return receiptFromRow(row)
}

async function writeNative(db: Client, eventKey: string, attemptId: string, native: DesktopNotifyUserNativeResult['status'], reason: string | null): Promise<void> {
    await db.execute({
        sql: `UPDATE desktop_user_notifications SET native_status = ?, reason = ?
              WHERE event_key = ? AND attempt_id = ? AND native_status IS NULL`,
        args: [native, native === 'shown' ? null : reason, eventKey, attemptId],
    })
}

async function settleSlot(db: Client, slot: Slot, native: DesktopNotifyUserNativeResult['status'], reason: string): Promise<DesktopNotifyUserReceipt> {
    if (slot.settled) return readStored(db, slot.key)
    slot.settled = true
    slot.handed = true
    slot.map.delete(slot.key)
    await writeNative(db, slot.key, slot.attemptId, native, reason)
    const receipt = await readStored(db, slot.key)
    slot.resolve(receipt)
    return receipt
}

function sameAdmission(row: Row, runtime: DesktopRuntime, input: DesktopUserNotificationInput) {
    if (Number(row.workspace_id) !== runtime.workspaceId || String(row.agent_engine_id) !== input.agentId || String(row.session_engine_id) !== input.sessionId
        || String(row.run_id) !== input.runId || String(row.tool_call_id) !== input.toolCallId || String(row.message) !== input.message || String(row.event_key) !== input.eventKey) {
        throw new DesktopHttpError(409, 'This notification does not match the admitted conversation.')
    }
}

function summary(message: string) { return message.replace(/\s+/g, ' ').trim().slice(0, 280) }

async function insertNotification(db: Client, runtime: DesktopRuntime, input: DesktopUserNotificationInput, owner: Owner, attemptId: string, createdAt: string, native: DesktopNotifyUserNativeResult['status'] | null, reason: string | null) {
    const tx = await db.transaction('write')
    try {
        const existing = await tx.execute({ sql: 'SELECT * FROM desktop_user_notifications WHERE id = ? OR event_key = ?', args: [input.notificationId, input.eventKey] })
        if (existing.rows[0]) {
            await tx.commit()
            return existing.rows[0]
        }
        const still = await ownerOf(tx as unknown as Client, input)
        if (!still || still.localAgentId !== owner.localAgentId || still.localSessionId !== owner.localSessionId || !still.enabled) throw new DesktopHttpError(409, 'The coworker or conversation changed.')
        await tx.execute({
            sql: `INSERT INTO desktop_user_notifications
                  (id, event_key, attempt_id, workspace_id, agent_engine_id, agent_local_id, session_engine_id, session_local_id, run_id, tool_call_id, message, native_status, reason, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [input.notificationId, input.eventKey, attemptId, runtime.workspaceId, input.agentId, owner.localAgentId, input.sessionId, owner.localSessionId, input.runId, input.toolCallId, input.message, native, reason, createdAt],
        })
        await tx.commit()
        return null
    } catch (error) {
        await tx.rollback().catch(() => {})
        throw error
    } finally { tx.close() }
}

function openSlot(db: Client, runtime: DesktopRuntime, input: DesktopUserNotificationInput, owner: Owner, attemptId: string, createdAt: string, deps: DesktopUserNotificationDeps, signal: AbortSignal): Slot {
    const map = scopeMap(runtime)
    const identity: Identity = {
        notificationId: input.notificationId, eventKey: input.eventKey, attemptId, agentId: input.agentId, sessionId: input.sessionId,
        runId: input.runId, message: input.message, metadata: null, createdAt,
    }
    let resolve!: (receipt: DesktopNotifyUserReceipt) => void
    const promise = new Promise<DesktopNotifyUserReceipt>(done => { resolve = done })
    const slot: Slot = {
        key: input.eventKey, attemptId, identity, db, map, handed: false, claiming: false, settled: false, resolve, promise,
        grant: async () => deps.grant(input.agentId, signal).then(grant => grant === 'granted').catch(() => false),
        confirm: () => deps.run(input, signal).catch(() => false),
        event: {
            key: input.eventKey, kind: 'info', source: 'chat', agentId: owner.localAgentId, agentName: owner.name, sessionId: owner.localSessionId,
            title: owner.name, subtitle: 'Needs you', body: desktopNotifyUserNativeBody(input.message) || null, silent: true, requestId: attemptId,
        },
    }
    map.set(slot.key, slot)
    return slot
}

export async function acceptDesktopUserNotification(db: Client, runtime: DesktopRuntime, input: DesktopUserNotificationInput, signal: AbortSignal, deps: DesktopUserNotificationDeps, timeoutMs = DESKTOP_USER_NOTIFICATION_WAIT_MS): Promise<DesktopNotifyUserReceipt> {
    signal.throwIfAborted()
    assertIdentity(input)
    await ensureDesktopUserNotifications(db)
    const owner = await ownerOf(db, input)
    if (!owner || !owner.enabled) throw new DesktopHttpError(owner ? 403 : 404, owner ? 'This coworker cannot send notifications.' : 'The coworker or conversation was not found.')
    if (await deps.grant(input.agentId, signal) !== 'granted') throw new DesktopHttpError(403, 'This coworker cannot send notifications.')
    if (!await deps.run(input, signal)) throw new DesktopHttpError(409, 'This notification is no longer part of the active run.')
    signal.throwIfAborted()
    const prepared = await withRosterWrite(async () => {
        assertDesktopWorkspaceAdmission(runtime)
        signal.throwIfAborted()
        const existing = (await db.execute({ sql: 'SELECT * FROM desktop_user_notifications WHERE id = ? OR event_key = ?', args: [input.notificationId, input.eventKey] })).rows[0]
        if (existing) {
            sameAdmission(existing, runtime, input)
            const slot = findSlot(runtime, input.eventKey)
            return slot && !slot.settled ? { slot } : { receipt: receiptFromRow(existing) }
        }
        const prefs = await readPrefs(db)
        const attention = desktopInfoNotificationWanted(prefs, owner.localAgentId)
        const native = attention && (prefs.toast || prefs.sound) ? null : 'unavailable' as const
        const reason = native ? (attention ? 'Notification delivery channels are turned off.' : 'Notifications for this coworker are turned off.') : null
        if (await deps.grant(input.agentId, signal) !== 'granted') throw new DesktopHttpError(403, 'This coworker cannot send notifications.')
        if (!await deps.run(input, signal)) throw new DesktopHttpError(409, 'This notification is no longer part of the active run.')
        assertDesktopWorkspaceAdmission(runtime)
        signal.throwIfAborted()
        const attemptId = crypto.randomUUID()
        const createdAt = new Date().toISOString()
        const raced = await insertNotification(db, runtime, input, owner, attemptId, createdAt, native, reason)
        if (raced) {
            sameAdmission(raced, runtime, input)
            const slot = findSlot(runtime, input.eventKey)
            return slot && !slot.settled ? { slot } : { receipt: receiptFromRow(raced) }
        }
        if (native) return { receipt: await readStored(db, input.eventKey) }
        return { slot: openSlot(db, runtime, input, owner, attemptId, createdAt, deps, signal) }
    })
    if ('receipt' in prepared && prepared.receipt) return prepared.receipt
    const slot = prepared.slot!
    const raced = await raceReceipt(slot, timeoutMs, signal)
    if (raced === 'timeout') return settleSlot(db, slot, 'unknown', 'Native notification acknowledgement is unknown.')
    if (raced === 'abort') return settleSlot(db, slot, 'unknown', 'The run stopped before native delivery was confirmed.')
    return raced
}

function raceReceipt(slot: Slot, timeoutMs: number, signal: AbortSignal): Promise<DesktopNotifyUserReceipt | 'timeout' | 'abort'> {
    if (signal.aborted) return Promise.resolve('abort')
    return new Promise(resolve => {
        const finish = (result: DesktopNotifyUserReceipt | 'timeout' | 'abort') => {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            resolve(result)
        }
        const onAbort = () => finish('abort')
        const timer = setTimeout(() => finish('timeout'), timeoutMs)
        signal.addEventListener('abort', onAbort, { once: true })
        void slot.promise.then(finish)
    })
}

export function pendingDesktopUserNotificationEvents(runtime: DesktopRuntime): DesktopNotificationEvent[] {
    return [...(slotScopes().get(scopeKey(runtime))?.values() ?? [])].filter(slot => !slot.handed && !slot.settled && !slot.claiming).map(slot => slot.event)
}

export async function takeDesktopUserNotificationDelivery(runtime: DesktopRuntime, key: string): Promise<DesktopNotificationAdmission | null> {
    const slot = findSlot(runtime, key)
    if (!slot || slot.handed || slot.settled || slot.claiming) return null
    slot.claiming = true
    try {
        const granted = await slot.grant()
        const current = granted && await slot.confirm()
        if (slot.settled) return null
        assertDesktopWorkspaceAdmission(runtime)
        if (!granted || !current) {
            await settleSlot(slot.db, slot, granted ? 'unknown' : 'unavailable', granted ? 'The run stopped before native delivery was confirmed.' : 'The notification permission was turned off.')
            return null
        }
        slot.handed = true
        return { ...slot.event, attemptId: slot.attemptId }
    } finally { slot.claiming = false }
}

export async function settleDesktopUserNotification(runtime: DesktopRuntime, db: Client, input: DesktopNotificationReceipt): Promise<boolean> {
    return withRosterWrite(async () => {
        const slot = findSlot(runtime, input.key)
        if (!slot || slot.db !== db || !slot.handed || slot.settled || slot.attemptId !== input.attemptId) return false
        const native = nativeOf(input)
        const reason = native === 'shown' ? '' : native === 'unavailable' ? 'A native notification destination is unavailable.' : native === 'failed' ? 'Native notification delivery failed.' : 'Native notification acknowledgement is unknown.'
        await settleSlot(db, slot, native, reason)
        return true
    })
}

export async function readDesktopUserAttention(db: Client, runtime: DesktopRuntime): Promise<DesktopAttentionItem[]> {
    await ensureDesktopUserNotifications(db)
    const rows = (await db.execute({
        sql: `SELECT n.attempt_id, n.message, n.created_at, a.id AS agent_id, a.name AS agent_name, a.enabled AS enabled, s.id AS session_id, s.title AS title, s.updated_at AS updated_at
              FROM desktop_user_notifications n
              JOIN desktop_agents a ON a.id = n.agent_local_id AND a.engine_agent_id = n.agent_engine_id AND a.workspace_id = 1
              JOIN desktop_sessions s ON s.id = n.session_local_id AND s.agent_id = a.id AND s.engine_session_id = n.session_engine_id
              LEFT JOIN desktop_deletions d ON d.agent_id = a.id
              WHERE n.workspace_id = ? AND n.acknowledged_at IS NULL AND d.agent_id IS NULL
              ORDER BY n.created_at DESC LIMIT 100`,
        args: [runtime.workspaceId],
    })).rows
    return rows.map(row => ({
        id: String(row.attempt_id), kind: 'info' as const, agentId: String(row.agent_id), agentName: String(row.agent_name), agentEnabled: Number(row.enabled) !== 0,
        sessionId: String(row.session_id), title: String(row.title), summary: summary(String(row.message)), requestedAt: String(row.created_at), updatedAt: String(row.updated_at),
    }))
}

export async function acknowledgeDesktopUserNotification(db: Client, runtime: DesktopRuntime, item: { id: string; agentId: string; sessionId: string }): Promise<boolean> {
    await ensureDesktopUserNotifications(db)
    return withRosterWrite(async () => {
        const current = (await db.execute({
            sql: `SELECT n.id FROM desktop_user_notifications n
                  JOIN desktop_agents a ON a.id = n.agent_local_id AND a.engine_agent_id = n.agent_engine_id AND a.workspace_id = 1
                  JOIN desktop_sessions s ON s.id = n.session_local_id AND s.agent_id = a.id AND s.engine_session_id = n.session_engine_id
                  LEFT JOIN desktop_deletions d ON d.agent_id = a.id
                  WHERE n.attempt_id = ? AND n.workspace_id = ? AND n.agent_local_id = ? AND n.session_local_id = ? AND n.acknowledged_at IS NULL AND d.agent_id IS NULL`,
            args: [item.id, runtime.workspaceId, item.agentId, item.sessionId],
        })).rows[0]
        if (!current) return false
        const updated = await db.execute({
            sql: `UPDATE desktop_user_notifications SET acknowledged_at = ?
                  WHERE attempt_id = ? AND workspace_id = ? AND agent_local_id = ? AND session_local_id = ? AND acknowledged_at IS NULL`,
            args: [new Date().toISOString(), item.id, runtime.workspaceId, item.agentId, item.sessionId],
        })
        return Number(updated.rowsAffected) === 1
    })
}
