import type { Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, findDesktopSession, listDesktopAgents, listDesktopConnections, listDesktopSessions, readDesktopBootstrap, saveDesktopConnection } from './store'

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
        expect(bootstrap.connections).toEqual([])
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
    })

    it('stores only provider metadata, never API keys', async () => {
        await saveDesktopConnection(db, { id: 'connection-1', provider: 'openai', name: 'OpenAI' })
        await expect(listDesktopConnections(db)).resolves.toEqual([{ id: 'connection-1', provider: 'openai', name: 'OpenAI' }])
        const columns = await db.execute("PRAGMA table_info('desktop_connections')")
        expect(columns.rows.map(row => String(row.name))).not.toContain('apiKey')
        expect(columns.rows.map(row => String(row.name))).not.toContain('api_key')
    })
})
