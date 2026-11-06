import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopCoworkerShareSource } from '@rerun/contracts'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { createDesktopCoworkerShareService } from './service'
import { createDesktopCoworkerShareStore } from './store'

let db: Client
let directory: string
const include = { memories: false, database: false, files: false }
const source = (revision: number, content = 'Be helpful.'): DesktopCoworkerShareSource => ({
    workspaceId: 1, agentId: 'agent-a', name: 'Ada', description: '', revision: revision.toString(16).padStart(64,'0'),
    setup: { required: false, prompt: '', answered: false }, config: {}, envKeys: [], mcpAuth: [],
    members: [{ path: 'SOUL.md', bytes: Buffer.from(content), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' }],
})
const input = (current: DesktopCoworkerShareSource) => ({ workspaceId: 1, agentId: current.agentId, sourceRevision: current.revision, requestId: `export-${current.revision}`, include })
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(),'rerun-share-retention-'))
    db = createClient({ url: `file:${join(directory,'app.db')}` })
    await ensureDesktopCoworkerShareSchema(db)
})
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); await rm(directory,{ recursive: true,force: true }) })

const create = (limits: { maxEntries?: number; maxBytes?: number; ttlMs?: number } = {}) => {
    const store = createDesktopCoworkerShareStore(db)
    const service = createDesktopCoworkerShareService(store,{ install: vi.fn() },{ reviewLimits: limits })
    return { store,service }
}

test('bounds simultaneous reviews without evicting an exact pending export, then releases capacity after durable ACK', async () => {
    const { store,service } = create({ maxEntries: 1 })
    const first = source(1), second = source(2)
    const reviewed = await service.review(input(first),first)
    await expect(service.review(input(second),second)).rejects.toMatchObject({ status: 409 })
    // An unsuccessful publication cannot free the still-unpersisted exact review.
    const publish = vi.spyOn(store,'publishExport').mockRejectedValueOnce(new Error('No publication ACK'))
    const operation = { ...input(first),reviewId: reviewed.reviewId,expectedDigest: reviewed.manifest.contentDigest }
    await expect(service.export(operation,first)).rejects.toThrow('No publication ACK')
    await expect(service.review(input(second),second)).rejects.toMatchObject({ status: 409 })
    const exported = await service.export(operation,first)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(exported.archiveSha256).toBe(reviewed.archiveSha256)
    await expect(service.review(input(second),second)).resolves.toMatchObject({ reused: false })
    const replay = await service.export(operation,first)
    expect(replay.reused).toBe(true)
    expect(replay.archiveSha256).toBe(reviewed.archiveSha256)
    expect((await db.execute('SELECT COUNT(*) AS n FROM desktop_coworker_share_receipts')).rows[0]!.n).toBe(1)
})

test('expiry releases idle raw archives while durable export identity and bytes still replay', async () => {
    const { service } = create({ maxEntries: 1,ttlMs: 100 })
    const first = source(1), second = source(2)
    const reviewed = await service.review(input(first),first)
    const operation = { ...input(first),reviewId: reviewed.reviewId,expectedDigest: reviewed.manifest.contentDigest }
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 200)
    await expect(service.export(operation,first)).rejects.toThrow('uncommitted review expired')
    await service.review(input(second),second)
    // Persist a fresh review and verify a later expiry cannot erase its durable receipt.
    vi.useRealTimers()
    const secondReview = await service.review(input(second),second)
    const secondOperation = { ...input(second),reviewId: secondReview.reviewId,expectedDigest: secondReview.manifest.contentDigest }
    const exported = await service.export(secondOperation,second)
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 200)
    const replay = await service.export(secondOperation,second)
    expect(replay.reused).toBe(true)
    expect(replay.archiveSha256).toBe(exported.archiveSha256)
    expect(replay.manifest).toEqual(exported.manifest)
})

test('reserves a byte budget before packing another review and keeps an existing smaller review usable', async () => {
    const { service } = create({ maxBytes: 64 * 1024 })
    const small = source(1), large = source(2,'x'.repeat(40 * 1024))
    const reviewed = await service.review(input(small),small)
    await expect(service.review(input(large),large)).rejects.toMatchObject({ status: 413 })
    const exported = await service.export({ ...input(small),reviewId: reviewed.reviewId,expectedDigest: reviewed.manifest.contentDigest },small)
    expect(exported.archiveSha256).toBe(reviewed.archiveSha256)
    expect((await db.execute('SELECT COUNT(*) AS n FROM desktop_coworker_shares')).rows[0]!.n).toBe(1)
})

test('a review actively publishing remains pinned through expiry until its receipt is acknowledged', async () => {
    const { store,service } = create({ maxEntries: 1,ttlMs: 100 })
    const first = source(1), second = source(2)
    const reviewed = await service.review(input(first),first)
    const publish = store.publishExport.bind(store)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(store,'publishExport').mockImplementation(async (...args) => { started(); await gate; return publish(...args) })
    const operation = { ...input(first),reviewId: reviewed.reviewId,expectedDigest: reviewed.manifest.contentDigest }
    const pending = service.export(operation,first)
    await entered
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 200)
    await expect(service.review(input(second),second)).rejects.toMatchObject({ status: 409 })
    release()
    const exported = await pending
    expect(exported.archiveSha256).toBe(reviewed.archiveSha256)
    await expect(service.review(input(second),second)).resolves.toMatchObject({ reused: false })
})

test('a lost ACK after persistence keeps the exact request and durable retry frees retained capacity', async () => {
    const { store,service } = create({ maxEntries: 1 })
    const first = source(1), second = source(2)
    const reviewed = await service.review(input(first),first)
    const publish = store.publishExport.bind(store)
    vi.spyOn(store,'publishExport').mockImplementationOnce(async (...args) => { await publish(...args); throw new Error('Lost ACK after commit') })
    const operation = { ...input(first),reviewId: reviewed.reviewId,expectedDigest: reviewed.manifest.contentDigest }
    await expect(service.export(operation,first)).rejects.toThrow('Lost ACK after commit')
    await expect(service.review(input(second),second)).rejects.toMatchObject({ status: 409 })
    const replay = await service.export(operation,first)
    expect(replay.reused).toBe(true)
    expect(replay.archiveSha256).toBe(reviewed.archiveSha256)
    await expect(service.review(input(second),second)).resolves.toMatchObject({ reused: false })
    const receipt = await store.receipt(operation.requestId)
    expect(receipt).toMatchObject({ requestId: operation.requestId,snapshotId: reviewed.manifest.packageKey,status: 'created' })
})
