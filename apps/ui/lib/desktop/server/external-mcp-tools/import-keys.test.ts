import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { admitDesktopImportCall, markDesktopImportKey, readDesktopImportKey } from './import-keys'

let db: Client
const key = '11111111-1111-4111-8111-111111111111'
beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await db.execute('CREATE TABLE desktop_external_import_keys (key_id TEXT PRIMARY KEY, source TEXT NOT NULL, bound_agent_id TEXT, claim TEXT, created_at TEXT NOT NULL)')
})
afterEach(() => db.close())

it('leaves an ordinary key alone', async () => {
    expect(await admitDesktopImportCall(db, key, 'delete_agent', {}, 'r1')).toBeNull()
})

it('lets an import key create one coworker and then write only to it', async () => {
    await markDesktopImportKey(db, key, 'openclaw')
    await markDesktopImportKey(db, key, 'hermes')
    expect(await readDesktopImportKey(db, key)).toEqual({ keyId: key, source: 'openclaw', boundAgentId: null, claim: null })
    await expect(admitDesktopImportCall(db, key, 'upsert_skill', { agentId: 'a' }, 'r0')).rejects.toThrow('Call create_agent first')
    const creating = await admitDesktopImportCall(db, key, 'create_agent', { name: 'Imported' }, 'r1')
    await expect(admitDesktopImportCall(db, key, 'create_agent', { name: 'Again' }, 'r2')).rejects.toThrow('already creating')
    await creating!.settle('coworker-1')
    expect(await readDesktopImportKey(db, key)).toMatchObject({ boundAgentId: 'coworker-1', claim: null })
    await expect(admitDesktopImportCall(db, key, 'create_agent', { name: 'Again' }, 'r3')).rejects.toThrow('already created its coworker')
    await expect(admitDesktopImportCall(db, key, 'write_memory', { agentId: 'someone-else' }, 'r4')).rejects.toThrow('only writes to its own coworker')
    expect(await admitDesktopImportCall(db, key, 'write_memory', { agentId: 'coworker-1' }, 'r5')).not.toBeNull()
})

it('refuses everything outside the import tools', async () => {
    await markDesktopImportKey(db, key, 'other')
    for (const tool of ['delete_agent', 'send_message', 'db_query', 'list_agents', 'detach_connector']) {
        await expect(admitDesktopImportCall(db, key, tool, {}, 'r1')).rejects.toThrow('is not available to an import key')
    }
})

it('frees the key when the creation fails, so it can be tried again', async () => {
    await markDesktopImportKey(db, key, 'other')
    const first = await admitDesktopImportCall(db, key, 'create_agent', {}, 'r1')
    await first!.settle(null)
    const second = await admitDesktopImportCall(db, key, 'create_agent', {}, 'r2')
    await second!.settle('coworker-2')
    expect((await readDesktopImportKey(db, key))?.boundAgentId).toBe('coworker-2')
})
