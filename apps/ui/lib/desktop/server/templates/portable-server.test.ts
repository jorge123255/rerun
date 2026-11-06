import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopPortableTemplateServer, initializeDesktopPortableTemplates } from './portable-server'

let directory: string
let db: Client
beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'portable-server-')))
    db = createClient({ url: `file:${join(directory, 'app.db')}` })
    await initializeDesktopPortableTemplates(db)
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
const operation = () => ({ operation: 'export' as const, requestId: randomUUID(), templateId: 'a'.repeat(32), revision: 'b'.repeat(64) })
const exported = (input: ReturnType<typeof operation>) => ({
    status: 'exported' as const, requestId: input.requestId, receiptId: input.requestId, templateId: input.templateId, revision: input.revision,
    artifactId: 'c'.repeat(32), contentDigest: 'd'.repeat(64), bytes: 50, fileName: 'fixture.tar.gz',
    fidelity: { binaryAssets: false, userSkillTrees: false, sourceKind: 'local-v1-export' as const, notes: [] },
})
function server(post: (path: string, body: unknown) => Promise<unknown>) {
    return createDesktopPortableTemplateServer({ db, engine: { post, get: async () => null }, publishDownloadArtifact: async () => ({ artifactId: 'c'.repeat(32) }) })
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('two servers share one executing attempt and seal the export artifact with its result', async () => {
    const input = operation(), result = exported(input)
    const entered = deferred<void>(), completion = deferred<unknown>()
    const post = vi.fn(async () => { entered.resolve(); return completion.promise })
    const first = server(post).handle(input)
    await entered.promise
    const second = server(post).handle(input)
    completion.resolve(result)
    expect(await first).toEqual(result)
    expect(await second).toEqual(result)
    expect(post).toHaveBeenCalledTimes(1)
    expect((await db.execute('SELECT status FROM desktop_portable_template_requests')).rows[0]?.status).toBe('acknowledged')
    expect((await db.execute('SELECT artifact_id FROM desktop_portable_template_artifacts')).rows).toHaveLength(1)
    expect(await server(post).handle(input)).toEqual(result)
    expect(post).toHaveBeenCalledTimes(1)
})

test('a late transport failure cannot downgrade a result already sealed by recovery', async () => {
    const input = operation(), result = exported(input)
    const post = vi.fn(async () => {
        await db.execute({ sql: "UPDATE desktop_portable_template_requests SET status = 'acknowledged', payload = ? WHERE request_id = ?", args: [JSON.stringify(result), input.requestId] })
        throw new Error('Late transport loss')
    })
    expect(await server(post).handle(input)).toEqual(result)
    expect((await db.execute('SELECT status FROM desktop_portable_template_requests')).rows[0]?.status).toBe('acknowledged')
})

test('an artifact insertion failure rolls back the terminal acknowledgement and allows the exact retry', async () => {
    const input = operation(), result = exported(input)
    const transaction = db.transaction.bind(db)
    let injected = false
    vi.spyOn(db, 'transaction').mockImplementation(async () => {
        const tx = await transaction('write')
        const execute = tx.execute.bind(tx)
        vi.spyOn(tx, 'execute').mockImplementation(async statement => {
            const sql = typeof statement === 'string' ? statement : statement.sql
            if (!injected && sql.includes('INSERT INTO desktop_portable_template_artifacts')) { injected = true; throw new Error('Disk full before artifact receipt') }
            return execute(statement)
        })
        return tx
    })
    const post = vi.fn(async () => result)
    expect(await server(post).handle(input)).toMatchObject({ status: 'uncertain' })
    expect(injected).toBe(true)
    expect((await db.execute('SELECT status FROM desktop_portable_template_requests')).rows[0]?.status).toBe('uncertain')
    expect((await db.execute('SELECT artifact_id FROM desktop_portable_template_artifacts')).rows).toHaveLength(0)
    expect(await server(post).handle(input)).toEqual(result)
    expect((await db.execute('SELECT artifact_id FROM desktop_portable_template_artifacts')).rows).toHaveLength(1)
})

test('a response for another request never seals or registers an artifact', async () => {
    const input = operation()
    expect(await server(async () => exported(operation())).handle(input)).toMatchObject({ status: 'uncertain' })
    expect((await db.execute('SELECT artifact_id FROM desktop_portable_template_artifacts')).rows).toHaveLength(0)
    expect((await db.execute('SELECT status FROM desktop_portable_template_requests')).rows[0]?.status).toBe('uncertain')
})

test('an acknowledged export with a lost renderer reply recovers its original request after database reopen', async () => {
    const input = operation(), result = exported(input)
    const post = vi.fn(async () => result)
    expect(await server(post).prepare({ operation: input })).toEqual(input)
    expect(await server(post).handle(input)).toEqual(result)
    db.close()
    db = createClient({ url: `file:${join(directory, 'app.db')}` })
    const resumed = server(post)
    expect(await resumed.prepare({ operation: { ...input, requestId: randomUUID() } })).toEqual(input)
    expect(await resumed.handle(input)).toEqual(result)
    expect(post).toHaveBeenCalledTimes(1)
    await resumed.acknowledge(input.requestId)
    const next = { ...input, requestId: randomUUID() }
    expect(await resumed.prepare({ operation: next })).toEqual(next)
})

test('pending import is server-owned across origins and cannot be replaced by a different file', async () => {
    const input = { operation: 'import-package' as const, requestId: randomUUID(), uploadId: randomUUID() }
    const post = vi.fn(async () => { throw new Error('Connection lost') })
    await server(post).prepare({ operation: input })
    await server(post).acknowledge(input.requestId)
    expect(await server(post).pendingImport()).toEqual(input)
    expect(await server(post).handle(input)).toMatchObject({ status: 'uncertain' })
    db.close()
    db = createClient({ url: `file:${join(directory, 'app.db')}` })
    expect(await server(post).pendingImport()).toEqual(input)
    expect(await server(post).prepare({ operation: { ...input, requestId: randomUUID() } })).toEqual(input)
    await expect(server(post).prepare({ operation: { ...input, requestId: randomUUID(), uploadId: randomUUID() } })).rejects.toThrow(/earlier import/)
})
