import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerSnapshot, type DesktopCoworkerShareSource } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { createDesktopCoworkerShareService } from './service'
import { createDesktopCoworkerShareStore } from './store'

let db: Client
let source: DesktopCoworkerShareSource
beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await db.executeMultiple('CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT);')
    await ensureDesktopCoworkerShareSchema(db)
    source = { workspaceId: 1, agentId: 'agent-a', name: 'Ada', description: '', revision: 'a'.repeat(64), setup: { required: false, prompt: '', answered: true }, config: { setup: { required: false } }, envKeys: [], mcpAuth: [], members: [{ path: 'SOUL.md', bytes: Buffer.from('Be helpful.'), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' }] }
})
afterEach(() => db.close())

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
    await service.import({ requestId: 'import-a', snapshotId: first.manifest.packageKey, expectedDigest: first.manifest.contentDigest, targetWorkspaceId: 2 })
    await service.import({ requestId: 'import-b', snapshotId: first.manifest.packageKey, expectedDigest: first.manifest.contentDigest, targetWorkspaceId: 2 })
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
