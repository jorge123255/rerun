import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDesktopCoworkerSnapshot, type DesktopCoworkerShareSource } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { createDesktopCoworkerShareStore } from './store'

let db: Client
let directory = ''
const source: DesktopCoworkerShareSource = {
    workspaceId: 1, agentId: 'agent-a', name: 'Ada', description: '', revision: 'a'.repeat(64), setup: { required: false, prompt: '', answered: true }, config: { setup: { required: false } }, envKeys: [], mcpAuth: [],
    members: [{ path: 'SOUL.md', bytes: Buffer.from('Be helpful.'), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' }],
}
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(),'rerun-share-store-'))
    db = createClient({ url: `file:${join(directory,'app.db')}` })
    await db.executeMultiple('CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT);')
    await ensureDesktopCoworkerShareSchema(db)
})
afterEach(async () => { db.close(); await rm(directory,{ recursive: true,force: true }) })

test('same fingerprint reuses one immutable snapshot and withdrawal blocks only future retrieval', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    expect((await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)).reused).toBe(false)
    expect((await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)).reused).toBe(true)
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_coworker_shares')).rows[0]!.count).toBe(1)
    const receipt = await store.revoke(snapshot.manifest.packageKey, source.revision, 'revoke-request')
    expect(receipt.requestId).toBe('revoke-request')
    await expect(store.revoke(snapshot.manifest.packageKey, source.revision, 'revoke-request')).resolves.toEqual(receipt)
    await expect(store.revoke(snapshot.manifest.packageKey, source.revision, 'new-request')).resolves.toMatchObject({ status: 'revoked',snapshotId: snapshot.manifest.packageKey,requestId: 'new-request' })
    await expect(store.revoke(snapshot.manifest.packageKey, '0'.repeat(64), 'revoke-request')).rejects.toMatchObject({ status: 409 })
    await expect(store.readArchive(snapshot.manifest.packageKey)).rejects.toMatchObject({ status: 409 })
    expect(snapshot.archiveBytes.length).toBeGreaterThan(0)
})

test('duplicate import returns the same disconnected coworker and another workspace gets a fresh identity', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)
    const input = { snapshotId: snapshot.manifest.packageKey,targetWorkspaceId: 2,requestId: 'request-a',expectedDigest: snapshot.manifest.contentDigest }
    await store.reserveImport(input)
    const first = await store.settleImport(input,'imported-a')
    const duplicate = await store.reserveImport({ ...input,requestId: 'request-b' })
    expect(duplicate.importedAgentId).toBe(first.importedAgentId)
    const another = { ...input,targetWorkspaceId: 3,requestId: 'request-c' }
    await store.reserveImport(another)
    const other = await store.settleImport(another,'imported-c')
    expect(other.importedAgentId).not.toBe(first.importedAgentId)
})

test('an unknown install is recoverable without claiming a rollback or erasing acknowledgement', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    await store.create(snapshot, source.agentId, { memories: false, database: false, files: false }, source.revision)
    const input = { snapshotId: snapshot.manifest.packageKey,targetWorkspaceId: 2,requestId: 'request-a',expectedDigest: snapshot.manifest.contentDigest }
    await store.reserveImport(input)
    await store.uncertainImport(input)
    const receipt = await store.receipt('request-a')
    expect(receipt).toMatchObject({ operation: 'import', status: 'uncertain', recoverable: true })
    await store.settleImport(input,'imported-a')
    await store.uncertainImport(input)
    expect(await store.receipt(input.requestId)).toMatchObject({ status: 'imported' })
})

test('a corrupt reserved import cannot become a false ACK or be overwritten by a new request', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const snapshot = await createDesktopCoworkerSnapshot(source,{ memories: false,database: false,files: false })
    await store.create(snapshot)
    const input = { snapshotId: snapshot.manifest.packageKey,targetWorkspaceId: 2,requestId: 'original',expectedDigest: snapshot.manifest.contentDigest }
    await store.reserveImport(input)
    await db.execute("UPDATE desktop_coworker_share_imports SET fingerprint='corrupt',status='imported',imported_agent_id='foreign'")
    await expect(store.reserveImport({ ...input,requestId: 'new' })).rejects.toMatchObject({ status: 503 })
    await expect(store.settleImport(input,'own')).rejects.toMatchObject({ status: 503 })
    expect((await db.execute('SELECT imported_agent_id FROM desktop_coworker_share_imports')).rows[0]!.imported_agent_id).toBe('foreign')
})
