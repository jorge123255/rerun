import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('server-only', () => ({}))
vi.mock('../database', () => ({ openDesktopDatabase: async () => state.db }))
vi.mock('../completed-actions', () => ({ readDesktopCompletions: async () => ({ items: [], unavailableAgentIds: [] }) }))
vi.mock('../attention', () => ({ readDesktopAttention: async () => ({ items: [], unavailableAgentIds: [], checkedAt: '' }) }))
vi.mock('../language', () => ({ readDesktopLocale: async () => 'en' }))
vi.mock('../settings', () => ({ engineOf: () => ({}) }))

const { admitDesktopNotificationEvents, finishDesktopNotificationAttempt, initializeDesktopNotifications, readDesktopNotificationEvents, writeDesktopNotificationPrefs } = await import('../notifications')
const { initializeDesktopPendingInbox } = await import('../pending-inbox-db')
const { initializeDesktopRound70 } = await import('../round70-schema')
const { upsertDesktopWorkItem } = await import('./store')
import type { DesktopRuntime } from '../runtime'

let root: string, db: Client, runtime: DesktopRuntime
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'work-notices-'))
    db = createClient({ url: `file:${join(root, 'app.db')}` })
    await db.executeMultiple(`
        CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE);
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, engine_agent_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE, engine_session_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT PRIMARY KEY, engine_agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE desktop_workspace (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO desktop_workspace (id, name) VALUES (1, 'Local');`)
    await initializeDesktopNotifications(db)
    await initializeDesktopPendingInbox(db)
    await initializeDesktopRound70(db)
    state.db = db
    runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'launch-a', buildId: 'qa', dataRoot: root, app: { origin: 'http://127.0.0.1:43110', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:43111', apiKey: 'fixture-only' } }
})
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }) })

const later = () => new Date(Date.now() + 60_000)
const work = async () => (await readDesktopNotificationEvents(runtime)).events.filter(event => event.key.startsWith('work-notice:'))

test('an approval the Chief of Staff recorded is announced once as a Mac notification from the Chief of Staff', async () => {
    await upsertDesktopWorkItem(db, '1', { kind: 'chief' }, [], { project: 'server', objective: 'Deploy 2.4', approvalRequired: 'Deploy 2.4 to production' }, later)
    const [event] = await work()
    expect(event).toMatchObject({ kind: 'approval', agentId: 'foreman', agentName: 'Chief of Staff', title: 'Chief of Staff', subtitle: 'Needs your approval · server', body: 'Deploy 2.4 to production (Deploy 2.4)' })
    const admitted = await admitDesktopNotificationEvents(runtime, [event!.key])
    expect(admitted.events.map(item => item.key)).toEqual([event!.key])
    await finishDesktopNotificationAttempt(db, { key: event!.key, attemptId: admitted.events[0]!.attemptId, status: 'shown' })
    expect(await work()).toEqual([])
    expect((await admitDesktopNotificationEvents(runtime, [event!.key])).events).toEqual([])
})

test('notifications switched off for the workspace silence it', async () => {
    await upsertDesktopWorkItem(db, '1', { kind: 'chief' }, [], { project: 'server', objective: 'Deploy 2.4', approvalRequired: 'Deploy 2.4 to production' }, later)
    await writeDesktopNotificationPrefs(db, { scope: 'nothing' } as never)
    expect(await work()).toEqual([])
})
