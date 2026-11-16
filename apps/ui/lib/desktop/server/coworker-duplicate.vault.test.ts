import { createClient } from '@libsql/client'
import { expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { inheritVaultAssignments } from './coworker-duplicate'

async function vault() {
    const db = createClient({ url: ':memory:' })
    await db.executeMultiple(`
        CREATE TABLE desktop_vault_secrets (id TEXT PRIMARY KEY, revision TEXT NOT NULL);
        CREATE TABLE desktop_vault_attachments (item_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(item_id,agent_id));
        CREATE TABLE desktop_vault_mcp_servers (id TEXT PRIMARY KEY, revision TEXT NOT NULL);
        CREATE TABLE desktop_vault_mcp_attachments (item_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(item_id,agent_id));
        CREATE TABLE desktop_vault_mcp_programs (id TEXT PRIMARY KEY, revision TEXT NOT NULL);
        CREATE TABLE desktop_vault_mcp_program_attachments (item_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(item_id,agent_id));
        INSERT INTO desktop_vault_secrets VALUES ('key-held','r1'),('key-other','r1'),('key-full','r1');
        INSERT INTO desktop_vault_attachments VALUES ('key-held','source'),('key-other','someone');
        INSERT INTO desktop_vault_mcp_servers VALUES ('app-held','r1');
        INSERT INTO desktop_vault_mcp_attachments VALUES ('app-held','source');
        INSERT INTO desktop_vault_mcp_programs VALUES ('program-held','r1');
        INSERT INTO desktop_vault_mcp_program_attachments VALUES ('program-held','source');
    `)
    await db.execute("INSERT INTO desktop_vault_attachments VALUES ('key-full','source')")
    for (let index = 0; index < 249; index++) await db.execute({ sql: "INSERT INTO desktop_vault_attachments VALUES ('key-full',?)", args: [`other-${index}`] })
    return db
}
const holders = async (db: ReturnType<typeof createClient>, table: string, agent: string) =>
    (await db.execute({ sql: `SELECT item_id FROM ${table} WHERE agent_id=? ORDER BY item_id`, args: [agent] })).rows.map(row => String(row.item_id))

it('a copy holds what its source held, and nothing else', async () => {
    const db = await vault()
    await db.batch(inheritVaultAssignments('source', 'copy'), 'write')
    expect(await holders(db, 'desktop_vault_attachments', 'copy')).toEqual(['key-held'])
    expect(await holders(db, 'desktop_vault_mcp_attachments', 'copy')).toEqual(['app-held'])
    expect(await holders(db, 'desktop_vault_mcp_program_attachments', 'copy')).toEqual(['program-held'])
    // The source keeps its own, and an entry at its limit is left out.
    expect(await holders(db, 'desktop_vault_attachments', 'source')).toEqual(['key-full', 'key-held'])
})

it('only the entries that gained the copy get a new revision, and a replay changes nothing more', async () => {
    const db = await vault()
    await db.batch(inheritVaultAssignments('source', 'copy'), 'write')
    const revisions = async () => Object.fromEntries((await db.execute('SELECT id,revision FROM desktop_vault_secrets')).rows.map(row => [String(row.id), String(row.revision)]))
    const first = await revisions()
    expect(first['key-held']).not.toBe('r1')
    expect(first['key-other']).toBe('r1')
    expect(first['key-full']).toBe('r1')
    await db.batch(inheritVaultAssignments('source', 'copy'), 'write')
    expect(await holders(db, 'desktop_vault_attachments', 'copy')).toEqual(['key-held'])
})
