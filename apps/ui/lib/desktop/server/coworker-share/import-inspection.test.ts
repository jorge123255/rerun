import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { captureDesktopCoworkerShareDatabase } from '../../../../../engine/src/desktop/coworker-share-database/capture'
import { PORTABLE_DATABASE_MEMBER } from '../../../../../engine/src/desktop/coworker-share-database/member'
import { createDesktopCoworkerSnapshot } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { readPortableArchive, sealPortableManifest, writePortableArchive } from '../../../../../engine/src/desktop/templates/portable-package'
import { DesktopHttpError } from '../auth'
import { inspectCoworkerImportDatabase } from './import-inspection'
import { createDesktopCoworkerShareApi } from './api'
import { createDesktopCoworkerShareService } from './service'
import { createDesktopCoworkerShareStore } from './store'
import { ensureDesktopCoworkerShareSchema } from './schema'

let db: Client
let directory: string
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-share-inspection-'))
    db = createClient({ url: `file:${join(directory, 'app.db')}` })
    await db.executeMultiple('CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY,agent_id TEXT);')
    await ensureDesktopCoworkerShareSchema(db)
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

async function databasePackage(empty = false) {
    const pkg = await captureDesktopCoworkerShareDatabase({ workspaceId: 1,agentId: 'agent-a',listPrivateSnapshot: async () => ({
        tables: empty ? [] : [
            { name: 'projects',columns: [{ name: 'label',type: 'TEXT',pk: false,notnull: false },{ name: 'asset',type: 'BLOB',pk: false,notnull: false }],rows: [{ label: 'ROW_VALUE_SENTINEL',asset: Buffer.from('BLOB_VALUE_SENTINEL') }] },
            { name: 'notes',columns: [{ name: 'label',type: 'TEXT',pk: false,notnull: false }],rows: [{ label: 'Another value' }] },
        ],
        views: empty ? [] : ['projects','notes'].map(table => ({ id: `${table}-view`,table,name: 'All',position: 0,config: { layout: 'table',columns: ['label'] } })),
    }) },{ requestId: 'source:agent-a',includeDatabase: true,capturedAt: '2026-11-06T00:00:00Z' })
    if ('unavailable' in pkg) throw new Error(pkg.reason)
    return pkg
}

async function snapshot(path?: string, bytes = Buffer.alloc(0)) {
    const base = await createDesktopCoworkerSnapshot({ workspaceId: 1,agentId: 'agent-a',name: 'Ada',description: '',revision: 'a'.repeat(64),setup: { required: false,prompt: '',answered: false },config: {},envKeys: [],mcpAuth: [],members: [{ path: 'SOUL.md',bytes: new Uint8Array(Buffer.from('Keep the project.')),kind: 'instruction',binary: false,textScanned: true,flagged: [],ownership: 'user' }] },{ memories: false,database: false,files: false })
    if (!path) return base
    const digest = createHash('sha256').update(bytes).digest('hex')
    const member = { agentKey: 'c01',path,bytes,digest }
    const { contentDigest: _digest,...body } = base.manifest
    const manifest = sealPortableManifest({ ...body,coworkers: body.coworkers.map(owner => ({ ...owner,members: [...owner.members,{ path,bytes: bytes.length,contentDigest: digest,kind: 'text',binary: false,textScanned: true,flagged: [] }] })) })
    const archive = await writePortableArchive({ title: manifest.title,packageKey: manifest.packageKey,manifest,members: [...base.members,member],startedAt: Date.now() })
    return { manifest,members: [...base.members,member],archiveBytes: archive.archiveBytes,archiveSha256: createHash('sha256').update(archive.archiveBytes).digest('hex') }
}

test('real archive inspection exposes only verified counts/digest and never invokes source or destination writes', async () => {
    const pkg = await databasePackage(), saved = await snapshot(PORTABLE_DATABASE_MEMBER,Buffer.from(JSON.stringify(pkg)))
    const store = createDesktopCoworkerShareStore(db)
    await store.create(saved)
    const reserve = vi.spyOn(store,'reserveImport'), install = vi.fn(), source = vi.fn(async () => { throw new Error('Original source must not be read') })
    const service = createDesktopCoworkerShareService(store,{ install })
    const api = createDesktopCoworkerShareApi(service,source)
    const response = await api.GET(new Request(`http://127.0.0.1/share?snapshotId=${saved.manifest.packageKey}&preview=1&inspection=1`))
    const result = await response.json()
    expect(result).toEqual({ manifest: saved.manifest,importReview: { manifestDigest: saved.manifest.contentDigest,database: { status: 'verified',contents: pkg.contents,viewCount: 2,digest: pkg.digest } } })
    expect(JSON.stringify(result)).not.toMatch(/ROW_VALUE_SENTINEL|BLOB_VALUE_SENTINEL|Uk9XX1ZBTFVFX1NFTlRJTkVM/)
    expect(source).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const oldPreview = await api.GET(new Request(`http://127.0.0.1/share?snapshotId=${saved.manifest.packageKey}&preview=1`))
    expect(await oldPreview.json()).toEqual({ manifest: saved.manifest })
})

test('missing section, verified empty database and legacy raw SQLite have different outcomes', async () => {
    const absent = await snapshot()
    expect(inspectCoworkerImportDatabase(await readPortableArchive(absent.archiveBytes)).database).toEqual({ status: 'absent' })
    const pkg = await databasePackage(true), empty = await snapshot(PORTABLE_DATABASE_MEMBER,Buffer.from(JSON.stringify(pkg)))
    expect(inspectCoworkerImportDatabase(await readPortableArchive(empty.archiveBytes)).database).toEqual({ status: 'verified',contents: pkg.contents,viewCount: 0,digest: pkg.digest })
    const legacy = await snapshot('data/agent.db',Buffer.from('SQLite format 3\0PRIVATE_LEGACY_VALUE'))
    expect(inspectCoworkerImportDatabase(await readPortableArchive(legacy.archiveBytes)).database).toEqual({ status: 'legacy' })
})

test('malformed, tampered or aliased logical members never become zero-count summaries or leak values', async () => {
    const pkg = await databasePackage()
    for (const bytes of [Buffer.from('{"private":"ROW_VALUE_SENTINEL"'),Buffer.from(JSON.stringify({ ...pkg,contents: { count: 0,bytes: 0 } })),Buffer.from([255,254])]) {
        const saved = await snapshot(PORTABLE_DATABASE_MEMBER,bytes), restored = await readPortableArchive(saved.archiveBytes)
        try { inspectCoworkerImportDatabase(restored); throw new Error('Unexpected acceptance') }
        catch (error) { expect(error).toMatchObject({ status: 409 }); expect(String(error)).not.toContain('ROW_VALUE_SENTINEL') }
    }
    const alias = await snapshot(PORTABLE_DATABASE_MEMBER.toUpperCase(),Buffer.from(JSON.stringify(pkg)))
    expect(() => inspectCoworkerImportDatabase(alias)).toThrow(/ambiguous/)
})

test('changed workspace authority after reading the archive cannot publish inspection metadata', async () => {
    const saved = await snapshot(), store = createDesktopCoworkerShareStore(db)
    await store.create(saved)
    let current = true
    const read = store.readArchive
    vi.spyOn(store,'readArchive').mockImplementation(async id => { const value = await read(id); current = false; return value })
    const service = createDesktopCoworkerShareService(store,{ install: vi.fn(),assertCurrent: async () => { if (!current) throw new DesktopHttpError(409,'Workspace changed') } })
    await expect(service.inspect(saved.manifest.packageKey)).rejects.toMatchObject({ status: 409 })
})

test('canceled inspection does not read or reserve an import', async () => {
    const store = createDesktopCoworkerShareStore(db), read = vi.spyOn(store,'readArchive'), reserve = vi.spyOn(store,'reserveImport')
    const service = createDesktopCoworkerShareService(store,{ install: vi.fn() }), controller = new AbortController()
    controller.abort()
    await expect(service.inspect('a'.repeat(32),controller.signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled()
})
