import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopCoworkerShareSource } from '../../../../../engine/src/desktop/coworker-share/snapshot'
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
const include = { memories: false, database: false, files: false }

test('review returns the exact SnapshotResult and scoped identity without persisting a share', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const service = createDesktopCoworkerShareService(store, { install: vi.fn() })
    const input = { workspaceId: 1, agentId: 'agent-a', sourceRevision: source.revision, requestId: 'review-a', include }
    const review = await service.review(input, source)
    expect(review.reviewId).toMatch(/^[a-f0-9]{64}$/)
    expect(review.reused).toBe(false)
    expect(review.manifest.coworkers[0]?.setup.answered).toBe(false)
    expect(review.archiveSha256).toHaveLength(64)
    expect(review.archiveBytes).toBeGreaterThan(0)
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_coworker_shares')).rows[0]!.count).toBe(0)
    const exported = await service.export({ ...input, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }, source)
    expect(exported.manifest).toEqual(review.manifest)
    expect(exported.archiveSha256).toBe(review.archiveSha256)
    expect(exported.reused).toBe(false)
    const replay = await service.export({ ...input, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }, source)
    expect(replay.reused).toBe(true)
    expect(replay.manifest).toEqual(exported.manifest)
})

test('lost acknowledgement after restart returns the persisted snapshot without regenerating it', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const first = createDesktopCoworkerShareService(store, { install: vi.fn() })
    const input = { workspaceId: 1, agentId: 'agent-a', sourceRevision: source.revision, requestId: 'export-a', include }
    const review = await first.review(input, source)
    const exported = await first.export({ ...input, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }, source)
    const restarted = createDesktopCoworkerShareService(store, { install: vi.fn() })
    const replay = await restarted.export({ ...input, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }, source)
    expect(replay.reused).toBe(true)
    expect(replay.manifest).toEqual(exported.manifest)
    expect(replay.archiveSha256).toBe(exported.archiveSha256)
    expect(replay.archiveBytes).toBe(exported.archiveBytes)
})

test('wrong review identity, digest or source revision refuses before persistence', async () => {
    const store = createDesktopCoworkerShareStore(db)
    const service = createDesktopCoworkerShareService(store, { install: vi.fn() })
    const input = { workspaceId: 1, agentId: 'agent-a', sourceRevision: source.revision, requestId: 'export-a', include }
    const review = await service.review(input, source)
    await expect(service.export({ ...input, reviewId: '0'.repeat(64), expectedDigest: review.manifest.contentDigest }, source)).rejects.toMatchObject({ status: 409 })
    await expect(service.export({ ...input, reviewId: review.reviewId, expectedDigest: '0'.repeat(64) }, source)).rejects.toMatchObject({ status: 409 })
    await expect(service.export({ ...input, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest, sourceRevision: 'b'.repeat(64) }, { ...source, revision: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_coworker_shares')).rows[0]!.count).toBe(0)
})
