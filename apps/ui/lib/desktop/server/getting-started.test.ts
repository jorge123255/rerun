import { createClient } from '@libsql/client'
import { describe, expect, it } from 'vitest'

import { COWORKERS_SQL, DESKTOP_GETTING_STARTED_SCHEMA, MODEL_CHATS_SQL, ensureDesktopGettingStartedSchema, readDesktopGettingStartedFacts } from './getting-started'

describe('desktop getting started facts', () => {
    it('keeps the queries inside one workspace and off the Foreman and deletions', () => {
        expect(COWORKERS_SQL).toContain('a.workspace_id = ?')
        expect(COWORKERS_SQL).toContain('a.engine_agent_id <> ?')
        expect(COWORKERS_SQL).toContain('desktop_deletions')
        expect(MODEL_CHATS_SQL).toContain('JOIN desktop_agents')
        expect(MODEL_CHATS_SQL).toContain('s.model_connection_id IS NOT NULL')
        expect(DESKTOP_GETTING_STARTED_SCHEMA).toContain('workspace_id INTEGER PRIMARY KEY')
    })

    it('reads coworkers and saved models, and leaves an unread routine list unknown', async () => {
        const db = createClient({ url: 'file::memory:' })
        await db.executeMultiple(`
            CREATE TABLE desktop_agents(id TEXT PRIMARY KEY, workspace_id INTEGER, engine_agent_id TEXT);
            CREATE TABLE desktop_deletions(agent_id TEXT);
            CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY, agent_id TEXT, model_connection_id TEXT, model TEXT);
            INSERT INTO desktop_agents VALUES ('cow', 4, 'engine-cow'), ('other', 9, 'engine-other'), ('foreman', 4, 'foreman'), ('gone', 4, 'engine-gone');
            INSERT INTO desktop_deletions VALUES ('gone');
            INSERT INTO desktop_sessions VALUES ('chat', 'cow', 'local', 'model-a'), ('blank', 'cow', NULL, NULL), ('elsewhere', 'other', 'local', 'model-b');
        `)
        await ensureDesktopGettingStartedSchema(db)
        const facts = await readDesktopGettingStartedFacts(db, 4, { schedules: null, connectedProviders: null })
        expect(facts).toEqual({ coworkers: 1, modelChats: 1, connectedProviders: null, schedules: null })
        db.close()
    })
})
