import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerSnapshot, type DesktopCoworkerShareSource } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { createDesktopCoworkerShareService } from './service'
import { createDesktopCoworkerShareStore } from './store'

let db: Client
let directory = ''
let source: DesktopCoworkerShareSource
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(),'rerun-share-service-'))
    db = createClient({ url: `file:${join(directory,'app.db')}` })
    await db.executeMultiple('CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT);')
    await ensureDesktopCoworkerShareSchema(db)
    source = { workspaceId: 1, agentId: 'agent-a', name: 'Ada', description: '', revision: 'a'.repeat(64), setup: { required: false, prompt: '', answered: true }, config: { setup: { required: false } }, envKeys: [], mcpAuth: [], members: [{ path: 'SOUL.md', bytes: Buffer.from('Be helpful.'), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' }] }
})
afterEach(async () => { db.close(); await rm(directory,{ recursive: true,force: true }) })

test('replay reuses the snapshot and changed source requires fresh review', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const install = vi.fn(async () => 'imported-a')
    const service = createDesktopCoworkerShareService(store, { install })
    const include = { memories: false, database: false, files: false }
    const exportInput = async (requestId: string, current = source) => {
        const review = await service.review({ workspaceId: 1, agentId: 'agent-a', sourceRevision: current.revision, requestId, include }, current)
        return { workspaceId: 1, agentId: 'agent-a', sourceRevision: current.revision, requestId, include, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }
    }
    const first = await service.export(await exportInput('request-a'), source)
    const replay = await service.export(await exportInput('request-b'), source)
    expect(replay.manifest.packageKey).toBe(first.manifest.packageKey)
    const changed = await service.export(await exportInput('request-c', { ...source, revision: 'b'.repeat(64) }), { ...source, revision: 'b'.repeat(64) })
    expect(changed.manifest.packageKey).not.toBe(first.manifest.packageKey)
    const originalImport = { requestId: 'import-a', snapshotId: first.manifest.packageKey, expectedDigest: first.manifest.contentDigest, targetWorkspaceId: 2 }
    const receipt = await service.import(originalImport)
    expect(receipt).toEqual({ status: 'imported', importedAgentId: 'imported-a' })
    expect(await service.import({ ...originalImport, requestId: 'import-b' })).toMatchObject({ status: 'uncertain', recoverable: true })
    expect(await service.import(originalImport)).toEqual(receipt)
    expect(install).toHaveBeenCalledTimes(1)
})

test('uncertain install returns recoverable state without claiming completion', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const service = createDesktopCoworkerShareService(store, { install: vi.fn(async () => { throw new Error('unknown acknowledgement') }) })
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    await store.create(snapshot)
    const result = await service.import({ requestId: 'import-a', snapshotId: snapshot.manifest.packageKey, expectedDigest: snapshot.manifest.contentDigest, targetWorkspaceId: 2 })
    expect(result).toMatchObject({ status: 'uncertain', recoverable: true })
})

test('archive altered after inspection refuses before import reservation or install', async () => {
    const store = createDesktopCoworkerShareStore(db), install = vi.fn(async () => 'must-not-install')
    const service = createDesktopCoworkerShareService(store, { install })
    const snapshot = await createDesktopCoworkerSnapshot(source, { memories: false, database: false, files: false })
    await store.create(snapshot)
    const inspected = await service.inspect(snapshot.manifest.packageKey)
    const changed = Buffer.from(snapshot.archiveBytes), offset = Math.floor(snapshot.archiveBytes.length / 2)
    changed[offset] = (changed[offset] ?? 0) ^ 1
    await db.execute({ sql: 'UPDATE desktop_coworker_shares SET archive_blob=? WHERE snapshot_id=?', args: [changed, snapshot.manifest.packageKey] })
    await expect(service.import({ requestId: 'altered-import', snapshotId: snapshot.manifest.packageKey, expectedDigest: inspected.importReview.manifestDigest, targetWorkspaceId: 2 })).rejects.toThrow()
    expect(install).not.toHaveBeenCalled()
    expect((await db.execute('SELECT count(*) AS n FROM desktop_coworker_share_imports')).rows[0]!.n).toBe(0)
})
