import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, findDesktopSession, listDesktopAgents, listDesktopSessions, readDesktopBootstrap, setDesktopSessionModel } from './store'

let root: string
let db: Client

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-store-'))
    db = await openDesktopDatabase(root)
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
})

describe('desktop store', () => {
    it('reads the local profile and workspace without provider credentials', async () => {
        const bootstrap = await readDesktopBootstrap(db)
        expect(bootstrap.profile).toEqual({ id: 1, displayName: 'Local User' })
        expect(bootstrap.workspace).toEqual({ id: 1, name: 'My workspace' })
        expect(bootstrap.agents).toEqual([])
    })

    it('stores engine agent IDs separately from stable local IDs', async () => {
        const created = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Researcher', description: 'Finds answers' })
        expect(created.id).not.toBe('engine-agent-1')
        expect(created.engineAgentId).toBe('engine-agent-1')
        await expect(findDesktopAgent(db, created.id)).resolves.toMatchObject({ name: 'Researcher', workspaceId: 1 })
        await expect(listDesktopAgents(db)).resolves.toEqual([created])
    })

    it('maps local sessions to engine sessions and lists them newest first', async () => {
        const agent = await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Researcher' })
        const first = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-session-1', title: 'First' })
        const second = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-session-2', title: 'Second' })
        expect(second.id).not.toBe('engine-session-2')
        await expect(findDesktopSession(db, second.id)).resolves.toMatchObject({ agentId: agent.id, engineSessionId: 'engine-session-2' })
        await expect(listDesktopSessions(db, agent.id)).resolves.toEqual([second, first])
        expect(first).toMatchObject({ modelConnectionId: null, model: null })
    })

    it('keeps an older conversation when the model columns are added', async () => {
        await closeDesktopDatabase(root)
        await rm(join(root, 'app.db'), { force: true })
        await rm(join(root, 'app.db-wal'), { force: true })
        await rm(join(root, 'app.db-shm'), { force: true })
        const legacy = createClient({ url: `file:${join(root, 'app.db')}` })
        await legacy.executeMultiple(`
            CREATE TABLE desktop_sessions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                engine_session_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `)
        await legacy.execute({
            sql: 'INSERT INTO desktop_sessions (id, agent_id, engine_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            args: ['legacy-session', 'legacy-agent', 'engine-legacy', 'Legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
        })
        legacy.close()
        db = await openDesktopDatabase(root)
        const columns = await db.execute('PRAGMA table_info(desktop_sessions)')
        expect(columns.rows.map(row => String(row.name))).toEqual(expect.arrayContaining(['model_connection_id', 'model']))
        await expect(findDesktopSession(db, 'legacy-session')).resolves.toMatchObject({ title: 'Legacy', modelConnectionId: null, model: null })
        await db.execute({ sql: 'UPDATE desktop_sessions SET model_connection_id = ? WHERE id = ?', args: ['conn-only', 'legacy-session'] })
        await expect(findDesktopSession(db, 'legacy-session')).resolves.toMatchObject({ modelConnectionId: null, model: null })
        await setDesktopSessionModel(db, 'legacy-session', { connectionId: 'conn-local', model: 'model-chat' })
        await expect(findDesktopSession(db, 'legacy-session')).resolves.toMatchObject({ modelConnectionId: 'conn-local', model: 'model-chat' })
    })

})
