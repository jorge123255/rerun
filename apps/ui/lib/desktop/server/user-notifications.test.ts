import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test, vi } from 'vitest'
import { getAgent } from '@/lib/engine/client'
import { setDesktopWorkspaceFrozen } from './workspace-admission'
import { DesktopHttpError } from './auth'
import { finishDesktopNotificationAttempt, initializeDesktopNotifications } from './notifications'
import type { DesktopRuntime } from './runtime'
import { acknowledgeDesktopUserNotification, acceptDesktopUserNotification, classifyDesktopNotifyGrant, desktopInfoNotificationWanted, pendingDesktopUserNotificationEvents, readDesktopNotifyGrant, readDesktopUserAttention, settleDesktopUserNotification, takeDesktopUserNotificationDelivery, type DesktopUserNotificationDeps, type DesktopUserNotificationInput } from './user-notifications'
import { normalizeNotificationPrefs } from '@rerun/contracts'

vi.mock('@/lib/engine/client', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/engine/client')>(),
    getAgent: vi.fn(),
}))

const clients: Client[] = []
const roots: string[] = []
afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function runtime(dataRoot: string, workspaceId = 7, launchNonce = 'launch-a'): DesktopRuntime {
    return { protocolVersion: 1, workspaceId, launchNonce, buildId: 'qa', dataRoot, app: { origin: 'http://127.0.0.1:43110', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:43111', apiKey: 'fixture-only' } }
}

async function database() {
    const root = await mkdtemp(join(tmpdir(), 'notify-user-'))
    roots.push(root)
    const db = createClient({ url: `file:${join(root, 'app.db')}` })
    clients.push(db)
    await db.executeMultiple(`
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, engine_agent_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, engine_session_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT PRIMARY KEY, engine_agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE desktop_workspace (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO desktop_workspace (id, name) VALUES (1, 'Local');
    `)
    await initializeDesktopNotifications(db)
    const now = '2026-11-09T00:00:00.000Z'
    await db.execute({ sql: 'INSERT INTO desktop_agents (id,workspace_id,engine_agent_id,name,description,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', args: ['ada', 1, 'engine-ada', 'Ada', '', 1, now, now] })
    await db.execute({ sql: 'INSERT INTO desktop_sessions (id,agent_id,engine_session_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)', args: ['chat-ada', 'ada', 'session-ada', 'Launch notes', now, now] })
    await db.execute({ sql: 'INSERT INTO desktop_sessions (id,agent_id,engine_session_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)', args: ['chat-other', 'ada', 'session-other', 'Other chat', now, now] })
    return { db, root }
}

const input = (patch: Partial<DesktopUserNotificationInput> = {}): DesktopUserNotificationInput => ({
    notificationId: 'notify:engine-ada:session-ada:run-1:call-1',
    eventKey: 'notify-user:engine-ada:session-ada:run-1:call-1',
    toolCallId: 'call-1', agentId: 'engine-ada', sessionId: 'session-ada', runId: 'run-1', message: 'Please review the launch notes', ...patch,
})
const granted: DesktopUserNotificationDeps = { grant: async () => 'granted', run: async () => true }
async function count(db: Client) {
    const rows = await db.execute('SELECT COUNT(*) AS n FROM desktop_user_notifications')
    const attempts = await db.execute('SELECT COUNT(DISTINCT attempt_id) AS n FROM desktop_user_notifications')
    return { rows: Number(rows.rows[0].n), attempts: Number(attempts.rows[0].n) }
}
async function whenQueued(current: DesktopRuntime) {
    const started = Date.now()
    while (pendingDesktopUserNotificationEvents(current).length === 0) {
        if (Date.now() - started > 1000) throw new Error('notification was not queued')
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

test('classify keeps foreman and child runs out and requires an explicit grant', () => {
    expect(classifyDesktopNotifyGrant({ enabled: true, kind: 'foreman', tools: { desktopToolGrants: { notify: true } } })).toBe('foreman')
    expect(classifyDesktopNotifyGrant({ enabled: true, ephemeral: true, tools: { desktopToolGrants: { notify: true } } })).toBe('child')
    expect(classifyDesktopNotifyGrant({ enabled: true, tools: { desktopToolGrants: {} } })).toBe('revoked')
    expect(classifyDesktopNotifyGrant({ enabled: false, tools: { desktopToolGrants: { notify: true } } })).toBe('revoked')
    expect(classifyDesktopNotifyGrant({ enabled: true, tools: { desktopToolGrants: { notify: true } } })).toBe('granted')
    const prefs = normalizeNotificationPrefs({ version: 2, scope: 'needed', toast: true, coworkers: { ada: { mode: 'everything' } } })
    expect(desktopInfoNotificationWanted(prefs, 'ada')).toBe(true)
    expect(desktopInfoNotificationWanted(normalizeNotificationPrefs({ version: 2, scope: 'needed' }), 'ada')).toBe(false)
    expect(desktopInfoNotificationWanted(normalizeNotificationPrefs({ version: 2, scope: 'nothing' }), 'ada')).toBe(false)
    expect(desktopInfoNotificationWanted(normalizeNotificationPrefs({ version: 2, scope: 'mine', coworkers: { ada: { mode: 'muted' } } }), 'ada')).toBe(false)
    expect(desktopInfoNotificationWanted(normalizeNotificationPrefs({ version: 2, scope: 'mine' }), 'ada')).toBe(true)
})

test('admission binds the workspace, coworker, conversation and tool call, and refuses stale, revoked or mismatched requests', async () => {
    const { db, root } = await database()
    const current = runtime(root)
    const signal = new AbortController().signal
    await expect(acceptDesktopUserNotification(db, current, input(), signal, { grant: async () => 'revoked', run: async () => true }, 50)).rejects.toMatchObject({ status: 403 })
    await expect(acceptDesktopUserNotification(db, current, input(), signal, { grant: async () => 'foreman', run: async () => true }, 50)).rejects.toMatchObject({ status: 403 })
    await expect(acceptDesktopUserNotification(db, current, input(), signal, { grant: async () => 'child', run: async () => true }, 50)).rejects.toMatchObject({ status: 403 })
    await expect(acceptDesktopUserNotification(db, current, input(), signal, { grant: async () => 'granted', run: async () => false }, 50)).rejects.toMatchObject({ status: 409 })
    await expect(acceptDesktopUserNotification(db, current, input({ sessionId: 'missing', eventKey: 'notify-user:engine-ada:missing:run-1:call-1', notificationId: 'notify:engine-ada:missing:run-1:call-1' }), signal, granted, 50)).rejects.toMatchObject({ status: 404 })
    await expect(acceptDesktopUserNotification(db, current, input({ eventKey: 'notify-user:engine-ada:session-ada:run-1:other' }), signal, granted, 50)).rejects.toBeInstanceOf(DesktopHttpError)
    expect(await count(db)).toEqual({ rows: 0, attempts: 0 })
    const config = { enabled: true, kind: 'user', ephemeral: false, tools: { desktopToolGrants: { notify: true } } }
    vi.mocked(getAgent).mockResolvedValueOnce({ id: 'engine-ada', config } as never)
    expect(await readDesktopNotifyGrant(current, 'engine-ada', signal)).toBe('granted')
    vi.mocked(getAgent).mockResolvedValueOnce({ id: 'engine-ada', config: { ...config, ephemeral: true } } as never)
    expect(await readDesktopNotifyGrant(current, 'engine-ada', signal)).toBe('child')
    vi.mocked(getAgent).mockResolvedValueOnce({ id: 'another-agent', config } as never)
    expect(await readDesktopNotifyGrant(current, 'engine-ada', signal)).toBe('revoked')
})

test('one admitted call is durable across a duplicate, a lost acknowledgement and a restart, and native failure is not success', async () => {
    const { db, root } = await database()
    const current = runtime(root)
    let allow = true
    const deps: DesktopUserNotificationDeps = { grant: async () => allow ? 'granted' : 'revoked', run: async () => true }
    const pending = acceptDesktopUserNotification(db, current, input(), new AbortController().signal, deps, 1000)
    const duplicate = acceptDesktopUserNotification(db, current, input(), new AbortController().signal, deps, 1000)
    await whenQueued(current)
    expect(await count(db)).toEqual({ rows: 1, attempts: 1 })
    allow = false
    expect(await takeDesktopUserNotificationDelivery(current, input().eventKey)).toBeNull()
    const [first, second] = await Promise.all([pending, duplicate])
    expect(first).toMatchObject({ status: 'failed', nativeStatus: 'unavailable', attemptId: second.attemptId, message: input().message, metadata: null })
    expect(second.attemptId).toBe(first.attemptId)
    expect(pendingDesktopUserNotificationEvents(current)).toEqual([])
    const replay = await acceptDesktopUserNotification(db, current, input(), new AbortController().signal, granted, 50)
    expect(replay.attemptId).toBe(first.attemptId)
    expect(await count(db)).toEqual({ rows: 1, attempts: 1 })

    const fresh = input({ toolCallId: 'call-2', notificationId: 'notify:engine-ada:session-ada:run-1:call-2', eventKey: 'notify-user:engine-ada:session-ada:run-1:call-2' })
    const restartedRuntime = runtime(root, 7, 'launch-b')
    const waiting = acceptDesktopUserNotification(db, restartedRuntime, fresh, new AbortController().signal, granted, 1000)
    await whenQueued(restartedRuntime)
    const crashed = runtime(root, 7, 'launch-c')
    const recovered = await acceptDesktopUserNotification(db, crashed, fresh, new AbortController().signal, granted, 50)
    expect(recovered).toMatchObject({ status: 'unknown', nativeStatus: 'unknown' })
    expect(pendingDesktopUserNotificationEvents(crashed)).toEqual([])
    const attemptId = String((await db.execute({ sql: 'SELECT attempt_id FROM desktop_user_notifications WHERE event_key = ?', args: [fresh.eventKey] })).rows[0].attempt_id)
    const native = { key: fresh.eventKey, attemptId, status: 'shown' as const, nativeStatus: 'failed' as const }
    expect(await settleDesktopUserNotification(restartedRuntime, db, native)).toBe(false)
    expect(await takeDesktopUserNotificationDelivery(restartedRuntime, fresh.eventKey)).toMatchObject({ attemptId })
    expect(await settleDesktopUserNotification(crashed, db, native)).toBe(false)
    expect(await settleDesktopUserNotification(restartedRuntime, db, { ...native, attemptId: crypto.randomUUID() })).toBe(false)
    expect(await settleDesktopUserNotification(restartedRuntime, db, native)).toBe(true)
    expect(await settleDesktopUserNotification(restartedRuntime, db, { ...native, nativeStatus: 'shown' })).toBe(false)
    expect(await waiting).toMatchObject({ status: 'failed', nativeStatus: 'failed' })
    const failed = await acceptDesktopUserNotification(db, crashed, fresh, new AbortController().signal, granted, 50)
    expect(failed).toMatchObject({ status: 'failed', nativeStatus: 'failed' })
    expect(failed.status).not.toBe('shown')
    const seen = await db.execute({ sql: 'SELECT event_key FROM desktop_notifications_seen WHERE event_key = ?', args: [fresh.eventKey] })
    expect(seen.rows).toEqual([])
    expect(await count(db)).toEqual({ rows: 2, attempts: 2 })
})

test('acknowledgement clears only that row and ordinary failure notifications still release their own attempt', async () => {
    const { db, root } = await database()
    const current = runtime(root)
    const sibling = input({ toolCallId: 'call-9', sessionId: 'session-other', notificationId: 'notify:engine-ada:session-other:run-1:call-9', eventKey: 'notify-user:engine-ada:session-other:run-1:call-9', message: 'Leave this one unread' })
    const first = acceptDesktopUserNotification(db, current, input(), new AbortController().signal, granted, 1000)
    const second = acceptDesktopUserNotification(db, current, sibling, new AbortController().signal, granted, 1000)
    await whenQueued(current)
    await whenQueued(current)
    for (const key of [input().eventKey, sibling.eventKey]) {
        const admission = await takeDesktopUserNotificationDelivery(current, key)
        if (admission) await settleDesktopUserNotification(current, db, { key, attemptId: admission.attemptId, status: 'unknown', nativeStatus: 'unknown' })
    }
    await Promise.all([first, second])
    const open = await readDesktopUserAttention(db, current)
    expect(open.map(item => item.sessionId).sort()).toEqual(['chat-ada', 'chat-other'])
    expect(open.find(item => item.sessionId === 'chat-ada')).toMatchObject({ agentId: 'ada', agentName: 'Ada', kind: 'info', summary: 'Please review the launch notes' })
    expect(JSON.stringify(open)).not.toContain('engine-ada')
    const ada = open.find(item => item.sessionId === 'chat-ada')!
    expect(await acknowledgeDesktopUserNotification(db, current, { id: ada.id, agentId: 'ada', sessionId: 'chat-ada' })).toBe(true)
    expect(await acknowledgeDesktopUserNotification(db, current, { id: ada.id, agentId: 'ada', sessionId: 'chat-other' })).toBe(false)
    expect((await readDesktopUserAttention(db, current)).map(item => item.sessionId)).toEqual(['chat-other'])
    expect((await readDesktopUserAttention(db, runtime(root, 8))).map(item => item.id)).toEqual([])

    await db.execute({ sql: 'INSERT INTO desktop_notification_attempts (event_key,attempt_id,created_at) VALUES (?,?,?)', args: ['terminal:ordinary-error', '22222222-2222-4222-8222-222222222222', '2026-11-09T00:00:00.000Z'] })
    await finishDesktopNotificationAttempt(db, { key: 'terminal:ordinary-error', attemptId: '22222222-2222-4222-8222-222222222222', status: 'failed', nativeStatus: 'failed' })
    expect((await db.execute({ sql: 'SELECT event_key FROM desktop_notification_attempts WHERE event_key = ?', args: ['terminal:ordinary-error'] })).rows).toEqual([])
    expect((await db.execute({ sql: 'SELECT event_key FROM desktop_notification_attempts WHERE event_key = ?', args: [sibling.eventKey] })).rows).toHaveLength(0)
})

test('a refused preference still records the inbox row and does not queue a native send', async () => {
    const { db, root } = await database()
    const now = '2026-11-09T00:00:00.000Z'
    await db.execute({ sql: 'INSERT INTO desktop_notification_prefs (workspace_id,prefs,created_at,updated_at) VALUES (1,?,?,?)', args: [JSON.stringify({ version: 2, scope: 'nothing', toast: true, sound: true, email: false, coworkers: {}, tasks: {}, categories: { billing: true, product: true } }), now, now] })
    const current = runtime(root)
    const receipt = await acceptDesktopUserNotification(db, current, input(), new AbortController().signal, granted, 50)
    expect(receipt).toMatchObject({ status: 'failed', nativeStatus: 'unavailable' })
    expect(receipt.reason).toBe('Notifications for this coworker are turned off.')
    expect(pendingDesktopUserNotificationEvents(current)).toEqual([])
    expect((await readDesktopUserAttention(db, current)).map(item => item.sessionId)).toEqual(['chat-ada'])
    expect(await count(db)).toEqual({ rows: 1, attempts: 1 })
    const again = await acceptDesktopUserNotification(db, current, input(), new AbortController().signal, granted, 50)
    expect(again.attemptId).toBe(receipt.attemptId)
    expect(await count(db)).toEqual({ rows: 1, attempts: 1 })
})


test('a stopped or frozen admission leaves no inbox row, and normal multiline notices are supported', async () => {
    const { db, root } = await database()
    const current = runtime(root)
    let checks = 0
    await expect(acceptDesktopUserNotification(db, current, input(), new AbortController().signal, {
        grant: async () => 'granted',
        run: async () => ++checks === 1,
    }, 50)).rejects.toMatchObject({ status: 409 })
    setDesktopWorkspaceFrozen(current, true)
    await expect(acceptDesktopUserNotification(db, current, input(), new AbortController().signal, granted, 50)).rejects.toMatchObject({ status: 409 })
    expect(await count(db)).toEqual({ rows: 0, attempts: 0 })
    setDesktopWorkspaceFrozen(current, false)
    const receipt = await acceptDesktopUserNotification(db, current, input({ message: 'Review this.\nSecond line.' }), new AbortController().signal, granted, 10)
    expect(receipt.message).toBe('Review this.\nSecond line.')
    expect((await readDesktopUserAttention(db, current))[0]?.summary).toBe('Review this. Second line.')
})
