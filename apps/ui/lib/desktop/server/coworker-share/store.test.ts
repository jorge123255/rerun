import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDesktopCoworkerSnapshot, type DesktopCoworkerShareSource } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { createDesktopCoworkerShareStore } from './store'

let db: Client
const source: DesktopCoworkerShareSource = {
    workspaceId: 1, agentId: 'agent-a', name: 'Ada', description: '', revision: 'a'.repeat(64), setup: { required: false, prompt: '', answered: true }, config: { setup: { required: false } }, envKeys: [], mcpAuth: [],
    members: [{ path: 'SOUL.md', bytes: Buffer.from('Be helpful.'), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' }],
}
beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await db.executeMultiple('CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT);')
    await ensureDesktopCoworkerShareSchema(db)
})
afterEach(() => db.close())

test('same fingerprint reuses one immutable snapshot and withdrawal blocks only future retrieval', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    expect((await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)).reused).toBe(false)
    expect((await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)).reused).toBe(true)
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_coworker_shares')).rows[0]!.count).toBe(1)
    await store.revoke(snapshot.manifest.packageKey, source.revision)
    await expect(store.readArchive(snapshot.manifest.packageKey)).rejects.toMatchObject({ status: 409 })
    expect(snapshot.archiveBytes.length).toBeGreaterThan(0)
})

test('duplicate import returns the same disconnected coworker and another workspace gets a fresh identity', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)
    const first = await store.markImported(snapshot.manifest.packageKey, 2, 'request-a', 'imported-a')
    const duplicate = await store.markImported(snapshot.manifest.packageKey, 2, 'request-b', 'must-not-replace')
    expect(duplicate.importedAgentId).toBe(first.importedAgentId)
    const other = await store.markImported(snapshot.manifest.packageKey, 3, 'request-c', 'imported-c')
    expect(other.importedAgentId).not.toBe(first.importedAgentId)
})

test('rollback is recoverable and request receipts remain replayable', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)
    await store.markImported(snapshot.manifest.packageKey, 2, 'request-a', 'imported-a')
    await store.rollbackImport(snapshot.manifest.packageKey, 2, 'request-a', 'uncertain install')
    const receipt = await store.receipt('request-a')
    expect(receipt).toMatchObject({ operation: 'import', status: 'uncertain', recoverable: true })
})
