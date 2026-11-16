import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as unknown, locale: 'en', adopted: [] as Array<{ agentId: string; sessionId?: string | null }> }))
vi.mock('server-only', () => ({}))
vi.mock('./database', () => ({ openDesktopDatabase: async () => state.db }))
vi.mock('./completed-actions', () => ({ readDesktopCompletions: async () => ({ items: [], unavailableAgentIds: [] }) }))
vi.mock('./attention', () => ({ readDesktopAttention: async () => ({ items: [], unavailableAgentIds: [], checkedAt: '' }) }))
vi.mock('./language', () => ({ readDesktopLocale: async () => state.locale }))
vi.mock('./settings', () => ({ engineOf: () => ({}) }))
// The real adopter asks the engine whether the conversation is that coworker's scheduled one, then
// writes the local row. Here it writes the row for the conversation the engine made for the notice.
vi.mock('./schedules/adoption', () => ({
    adoptDesktopScheduleEvent: async (db: Client, _engine: unknown, event: { agentId: string; sessionId?: string | null }) => {
        state.adopted.push(event)
        if (!event.sessionId || event.sessionId === 'session-of-someone-else') return null
        await db.execute({ sql: `INSERT INTO desktop_sessions (id,agent_id,engine_session_id,title,created_at,updated_at)
            SELECT ?, id, ?, 'Daily digest', ?, ? FROM desktop_agents WHERE engine_agent_id = ? ON CONFLICT(engine_session_id) DO NOTHING`, args: [`local-${event.sessionId}`, event.sessionId, NOW, NOW, event.agentId] })
        return { sessionId: `local-${event.sessionId}` }
    },
}))

import type { NotificationPayload } from '@/lib/engine/types'
import { admitDesktopNotificationEvents, finishDesktopNotificationAttempt, initializeDesktopNotifications, readDesktopNotificationEvents, readDesktopTerminalBinding, recordDesktopRunTerminal, writeDesktopNotificationPrefs } from './notifications'
import { initializeDesktopPendingInbox } from './pending-inbox-db'
import { markDesktopPendingInboxRead } from './pending-inbox'
import { initializeDesktopRound70 } from './round70-schema'
import { acknowledgeDesktopRoutineAutoOff, readDesktopRoutineAutoOffAttention, recordDesktopRoutineAutoOff } from './routine-auto-off'
import type { DesktopRuntime } from './runtime'

const NOW = '2026-11-16T09:00:00.000Z'
const clients: Client[] = []
const roots: string[] = []
let db: Client
let runtime: DesktopRuntime
// After the install cutoff, which is stamped when the notification tables are first made.
const later = (ms = 60_000) => new Date(Date.now() + ms).toISOString()

beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'routine-auto-off-'))
    roots.push(root)
    db = createClient({ url: `file:${join(root, 'app.db')}` })
    clients.push(db)
    await db.executeMultiple(`
        CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE);
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, engine_agent_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE, engine_session_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT PRIMARY KEY, engine_agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE desktop_workspace (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO desktop_workspace (id, name) VALUES (1, 'Local');
        INSERT INTO desktop_agents (id,workspace_id,engine_agent_id,name,created_at,updated_at) VALUES ('mira',1,'engine-mira','Mira','${NOW}','${NOW}');
        INSERT INTO desktop_agents (id,workspace_id,engine_agent_id,name,created_at,updated_at) VALUES ('otto',1,'engine-otto','Otto','${NOW}','${NOW}');
        INSERT INTO desktop_sessions (id,agent_id,engine_session_id,title,created_at,updated_at) VALUES ('chat-run','mira','session-run','Daily digest','${NOW}','${NOW}');
    `)
    await initializeDesktopNotifications(db)
    await initializeDesktopPendingInbox(db)
    await initializeDesktopRound70(db)
    state.db = db; state.locale = 'en'; state.adopted = []
    runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'launch-a', buildId: 'qa', dataRoot: root, app: { origin: 'http://127.0.0.1:43110', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:43111', apiKey: 'fixture-only' } }
})
afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function notice(patch: Partial<NotificationPayload> = {}, disabledAt = later()): NotificationPayload {
    return {
        event: 'agent.notification', kind: 'error', agentId: 'engine-mira', sessionId: 'session-run', runId: 'run-10', source: 'schedule',
        message: 'Daily digest was turned off after 10 failed runs in a row. Turn it back on in Mira’s Routines.',
        metadata: { routineAutoOff: true, scheduleSlug: 'daily-digest', sourceName: 'Daily digest', coworkerName: 'Mira', disabledAt }, timestamp: disabledAt, ...patch,
    }
}
const failedRun = (): NotificationPayload => ({
    event: 'agent.schedule.completed', kind: 'error', agentId: 'engine-mira', sessionId: 'session-run', runId: 'run-10', source: 'schedule', message: 'Schedule "Daily digest" failed: model unavailable',
    metadata: { status: 'error', scheduleSlug: 'daily-digest', sourceName: 'Daily digest', error: 'model unavailable' }, timestamp: later(),
})
const events = async () => (await readDesktopNotificationEvents(runtime)).events
const off = (list: Awaited<ReturnType<typeof events>>) => list.filter(event => event.key.startsWith('routine-off:'))

test('the notice is kept once per switch-off and names the routine and the coworker', async () => {
    const payload = notice()
    expect(await recordDesktopRoutineAutoOff(runtime, payload)).toBe(true)
    // The engine sending it again changes nothing.
    expect(await recordDesktopRoutineAutoOff(runtime, payload)).toBe(false)
    const list = off(await events())
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
        kind: 'error', source: 'schedule', agentId: 'mira', agentName: 'Mira', sessionId: 'chat-run', title: 'Mira', subtitle: 'Daily digest', silent: false,
        body: 'Daily digest was turned off after 10 failed runs in a row. Turn it back on in Mira’s Routines.',
    })
    expect(list[0].terminalId).toBe(list[0].key)
    // A later switch-off of the same routine, after it was turned back on, is a new notice.
    expect(await recordDesktopRoutineAutoOff(runtime, notice({}, later(120_000)))).toBe(true)
    expect(off(await events())).toHaveLength(2)
})

test('it reaches the person when the coworker is muted, and the failed run it used to ride stays hidden', async () => {
    await writeDesktopNotificationPrefs(db, { coworkers: { mira: { mode: 'muted' } } })
    expect(await recordDesktopRunTerminal(runtime, failedRun())).toBe(true)
    await recordDesktopRoutineAutoOff(runtime, notice())
    const list = await events()
    expect(list.filter(event => event.key.startsWith('terminal:'))).toEqual([])
    expect(off(list)).toHaveLength(1)
})

test('it also passes a muted task and the "only when needed" scope, and nothing else is filtered differently', async () => {
    await writeDesktopNotificationPrefs(db, { scope: 'needed', coworkers: { mira: { mode: 'default', follow: false } } })
    await recordDesktopRunTerminal(runtime, failedRun())
    await recordDesktopRoutineAutoOff(runtime, notice())
    const list = await events()
    // The coworker's tasks are not followed, so its failed run stays quiet; the switch-off does not.
    expect(list.map(event => event.key.split(':')[0])).toEqual(['routine-off'])
    // An unmuted coworker's failed run is announced as it always was.
    await writeDesktopNotificationPrefs(db, { scope: 'everything', coworkers: { mira: { mode: 'everything' } } })
    expect((await events()).map(event => event.key.split(':')[0]).sort()).toEqual(['routine-off', 'terminal'])
})

test('notifications switched off for the whole workspace stay off, and the inbox still shows it', async () => {
    await writeDesktopNotificationPrefs(db, { scope: 'nothing' })
    await recordDesktopRoutineAutoOff(runtime, notice())
    expect(await events()).toEqual([])
    expect(await readDesktopRoutineAutoOffAttention(db, runtime, 'en')).toHaveLength(1)
})

test('it is announced exactly once: shown, then never offered again', async () => {
    await writeDesktopNotificationPrefs(db, { coworkers: { mira: { mode: 'muted' } } })
    await recordDesktopRoutineAutoOff(runtime, notice())
    const [event] = off(await events())
    const first = await admitDesktopNotificationEvents(runtime, [event.key])
    expect(first.events).toHaveLength(1)
    expect((await admitDesktopNotificationEvents(runtime, [event.key])).events).toEqual([])
    await finishDesktopNotificationAttempt(db, { key: event.key, attemptId: first.events[0].attemptId, status: 'shown', nativeStatus: 'shown' })
    expect(off(await events())).toEqual([])
    expect((await admitDesktopNotificationEvents(runtime, [event.key])).events).toEqual([])
})

test('a routine that never started a run gets the conversation the engine made for the notice', async () => {
    expect(await recordDesktopRoutineAutoOff(runtime, notice({ sessionId: 'session-notice', runId: null }))).toBe(true)
    expect(state.adopted).toEqual([{ agentId: 'engine-mira', sessionId: 'session-notice', runId: null }])
    const [event] = off(await events())
    expect(event.sessionId).toBe('local-session-notice')
    // A click opens that conversation, and only while the coworker and the conversation still exist.
    expect(await readDesktopTerminalBinding(db, event.key)).toEqual({ agentId: 'mira', sessionId: 'local-session-notice' })
    await db.execute("DELETE FROM desktop_sessions WHERE id = 'local-session-notice'")
    expect(await readDesktopTerminalBinding(db, event.key)).toBeNull()
})

test('a payload that is not a complete switch-off notice of this coworker is not kept', async () => {
    expect(await recordDesktopRoutineAutoOff(runtime, notice({ sessionId: null }))).toBe(false)
    expect(await recordDesktopRoutineAutoOff(runtime, notice({ sessionId: 'session-of-someone-else' }))).toBe(false)
    expect(await recordDesktopRoutineAutoOff(runtime, notice({ event: 'agent.schedule.completed' }))).toBe(false)
    expect(await recordDesktopRoutineAutoOff(runtime, notice({ metadata: { routineAutoOff: true, scheduleSlug: 'daily-digest' } }))).toBe(false)
    expect(await recordDesktopRoutineAutoOff(runtime, notice({ metadata: { routineAutoOff: 'yes', scheduleSlug: 'daily-digest', sourceName: 'Daily digest', disabledAt: later() } }))).toBe(false)
    // Another coworker's conversation cannot carry this coworker's notice.
    expect(await recordDesktopRoutineAutoOff(runtime, notice({ agentId: 'engine-otto' }))).toBe(false)
    expect((await db.execute('SELECT COUNT(*) AS n FROM desktop_routine_auto_off_notices')).rows[0].n).toBe(0)
})

test('it sits in the inbox in the person’s language until it is marked as read', async () => {
    await writeDesktopNotificationPrefs(db, { coworkers: { mira: { mode: 'muted' } } })
    await recordDesktopRoutineAutoOff(runtime, notice())
    const [item] = await readDesktopRoutineAutoOffAttention(db, runtime, 'fr')
    expect(item).toMatchObject({ kind: 'info', agentId: 'mira', agentName: 'Mira', sessionId: 'chat-run', summary: 'Daily digest a été désactivée après 10 échecs consécutifs. Réactivez-la dans les Routines de Mira.' })
    // Only the exact notice, for its own coworker and conversation.
    expect(await acknowledgeDesktopRoutineAutoOff(db, runtime, { id: item.id, agentId: 'otto', sessionId: item.sessionId })).toBe(false)
    expect(await acknowledgeDesktopRoutineAutoOff(db, runtime, { id: 'routine-off:not-a-real-notice', agentId: 'mira', sessionId: item.sessionId })).toBe(false)
    expect(await readDesktopRoutineAutoOffAttention(db, runtime, 'en')).toHaveLength(1)
    expect(await markDesktopPendingInboxRead(runtime, { items: [{ id: item.id, kind: 'info', agentId: item.agentId, sessionId: item.sessionId }] })).toEqual({ marked: 1, failedIds: [] })
    expect(await readDesktopRoutineAutoOffAttention(db, runtime, 'en')).toEqual([])
    // Marking it as read does not take back a notification not shown yet.
    expect(off(await events())).toHaveLength(1)
})

test('a deleted coworker takes its notices with it', async () => {
    await recordDesktopRoutineAutoOff(runtime, notice())
    await db.execute("INSERT INTO desktop_deletions (agent_id, engine_agent_id, name) VALUES ('mira','engine-mira','Mira')")
    expect(off(await events())).toEqual([])
    expect(await readDesktopRoutineAutoOffAttention(db, runtime, 'en')).toEqual([])
})
