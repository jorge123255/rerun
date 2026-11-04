import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    it.each(['create', 'delete'] as const)('reads roster and board from one snapshot when a concurrent %s commits between them', async change => {
        const originalAgent = await createDesktopAgent(db, { engineAgentId: 'original-owner', name: 'Original' })
        // Finish unrelated lazy icon migrations before installing the read barrier.
        const before = await readDesktopBootstrap(db)
        const writer = createClient({ url: `file:${join(root, 'app.db')}` })
        await writer.execute('PRAGMA foreign_keys = ON')
        let release!: () => void, arrived!: () => void
        const barrier = new Promise<void>(resolve => { release = resolve })
        const reachedRosterRead = new Promise<void>(resolve => { arrived = resolve })
        const transaction = db.transaction.bind(db)
        let armed = true
        const intercept = (execute: Client['execute']): Client['execute'] => async statement => {
            const sql = typeof statement === 'string' ? statement : statement.sql
            // Also gate the old standalone board read, so reverting the transaction
            // produces a deterministic mixed snapshot instead of a timing-dependent pass.
            if (sql === 'SELECT revision FROM desktop_board_state WHERE workspace_id = 1') await barrier
            const result = await execute(statement)
            if (armed && sql.startsWith('SELECT a.*, p.col AS board_col')) {
                armed = false
                arrived()
                await barrier
            }
            return result
        }
        const directSpy = vi.spyOn(db, 'execute').mockImplementation(intercept(db.execute.bind(db)))
        const readSpy = vi.spyOn(db, 'transaction').mockImplementation(async mode => {
            const tx = await transaction(mode)
            if (mode === 'read') vi.spyOn(tx, 'execute').mockImplementation(intercept(tx.execute.bind(tx)))
            return tx
        })
        let reading: ReturnType<typeof readDesktopBootstrap> | undefined
        try {
            reading = readDesktopBootstrap(db)
            await reachedRosterRead
            if (change === 'create') await createDesktopAgent(writer, { engineAgentId: 'concurrent-owner', name: 'Concurrent' })
            else await writer.batch([
                { sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [originalAgent.id] },
                'UPDATE desktop_board_state SET revision = revision + 1 WHERE workspace_id = 1',
            ], 'write')
            release()
            const captured = await reading
            expect(captured.agents).toEqual(before.agents)
            expect(captured.board).toEqual(before.board)
            const current = await readDesktopBootstrap(db)
            expect(current.board.revision).toBe(before.board.revision + 1)
            expect(current.agents).toHaveLength(change === 'create' ? 2 : 0)
            expect(current.board.placements.map(item => item.agentId)).toEqual(current.agents.map(agent => agent.id))
        } finally {
            release()
            await reading?.catch(() => {})
            readSpy.mockRestore()
            directSpy.mockRestore()
            writer.close()
        }
    })

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
