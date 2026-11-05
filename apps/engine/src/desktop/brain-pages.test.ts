import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRAIN_DB_MIGRATIONS } from '../db/brainDb.js'
import { createDesktopBrainPagesStore, DESKTOP_BRAIN_AUTHOR } from './brain-pages.js'
import { desktopBrainPagesRouteAllowed } from './brain-pages-policy.js'
import { createDesktopBrainPagesRouter } from './brain-pages-router.js'

const page = (content: string, baseHash: string | null = null) => ({ title: 'Company', type: 'company' as const, content, sources: [], baseHash })
let root: string, directory: string, db: Client, store: ReturnType<typeof createDesktopBrainPagesStore>
const previousMode = process.env.RERUN_DESKTOP_APP
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-brain-pages-')))
    directory = join(root, 'brain')
    await mkdir(directory)
    db = createClient({ url: `file:${join(root, 'brain.db')}` })
    for (const step of BRAIN_DB_MIGRATIONS) await step.up(db)
    store = createDesktopBrainPagesStore(directory, async () => db)
    process.env.RERUN_DESKTOP_APP = '1'
})
afterEach(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
    if (previousMode === undefined) delete process.env.RERUN_DESKTOP_APP
    else process.env.RERUN_DESKTOP_APP = previousMode
    vi.restoreAllMocks()
})

describe('desktop Brain original store compatibility', () => {
    it('writes original Markdown/contracts and FTS locally, with no network or private memory writes', async () => {
        const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'))
        await mkdir(join(root, 'agents'))
        await writeFile(join(root, 'agents', 'memory.md'), 'private sentinel')
        const saved = await store.savePage('company', page('## Work\nLocal facts and [[partner]].'))
        expect(saved.page.updatedBy).toBe(DESKTOP_BRAIN_AUTHOR)
        expect(saved.page.links).toEqual(['partner'])
        expect(await readFile(join(directory, 'company.md'), 'utf8')).toContain('type: company')
        expect((await store.listPages())[0]?.hash).toBe(saved.page.hash)
        expect((await db.execute("SELECT content FROM brain_chunks_fts WHERE brain_chunks_fts MATCH 'facts'")).rows).toHaveLength(1)
        expect((await db.execute('SELECT embedding FROM brain_chunks')).rows.every(row => row.embedding === null)).toBe(true)
        expect(await readFile(join(root, 'agents', 'memory.md'), 'utf8')).toBe('private sentinel')
        expect(network).not.toHaveBeenCalled()
    })
    it('rebuilds only the local derived index and preserves original revisions', async () => {
        const first = await store.savePage('company', page('old facts'))
        const raw = await readFile(join(directory, 'company.md'), 'utf8')
        await writeFile(join(directory, 'company.md'), raw.replace('old facts', 'new facts'))
        await expect(store.listPages()).rejects.toMatchObject({ status: 409 })
        expect(await store.rebuildLocalIndex()).toEqual({ indexed: 1 })
        expect((await store.readPage('company')).page.content).toBe('new facts')
        expect((await store.readRevision('company', first.revisions[0]!.id)).content).toBe('old facts')
    })
    it('merges same-author autosaves without replacing revision identity', async () => {
        const first = await store.savePage('company', page('first'))
        const edited = await store.savePage('company', page('edited', first.page.hash))
        expect(edited.revisions).toHaveLength(1)
        expect(edited.revisions[0]!.id).toBe(first.revisions[0]!.id)
        expect((await store.readRevision('company', first.revisions[0]!.id)).content).toBe('edited')
        await expect(store.listRevisions('unknown')).rejects.toMatchObject({ status: 404 })
    })
    it('serializes competing creates and stale edits with only one winner', async () => {
        const results = await Promise.allSettled([store.savePage('company', page('first')), store.savePage('company', page('second'))])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
        expect(rejected.reason.status).toBe(409)
        const first = await store.readPage('company')
        await expect(store.savePage('company', page('stale', '0'.repeat(32)))).rejects.toMatchObject({ status: 409 })
        expect((await store.readPage('company')).page.hash).toBe(first.page.hash)
    })
    it('keeps revision identity and requires the current hash for restore', async () => {
        const first = await store.savePage('company', page('original'))
        const id = first.revisions[0]!.id
        await db.execute({ sql: 'UPDATE brain_revisions SET created_at = ? WHERE id = ?', args: ['2000-01-01T00:00:00.000Z', id] })
        const second = await store.savePage('company', page('changed', first.page.hash))
        await expect(store.restorePage('company', id, first.page.hash)).rejects.toMatchObject({ status: 409 })
        const restored = await store.restorePage('company', id, second.page.hash)
        expect(restored.page.content).toBe('original')
        expect(restored.revisions).toHaveLength(3)
        expect((await store.readRevision('company', id)).content).toBe('original')
        await expect(store.readRevision('another-page', id)).rejects.toMatchObject({ status: 404 })
        await store.deletePage('company')
        expect(await store.listPages()).toEqual([])
        expect((await store.readRevision('company', id)).content).toBe('original')
        await expect(store.readPage('company')).rejects.toMatchObject({ status: 404 })
        await store.savePage('company', page('created again'))
        expect((await store.readRevision('company', id)).content).toBe('original')
        expect((await store.listRevisions('company'))).toHaveLength(4)
    })
    it('rolls back index/history when recording a revision fails', async () => {
        await db.executeMultiple("CREATE TRIGGER fail_revision BEFORE INSERT ON brain_revisions BEGIN SELECT RAISE(ABORT, 'test revision failure'); END;")
        await expect(store.savePage('company', page('fails'))).rejects.toBeDefined()
        expect((await db.execute('SELECT * FROM brain_pages')).rows).toEqual([])
        expect((await db.execute('SELECT * FROM brain_revisions')).rows).toEqual([])
        await expect(readFile(join(directory, 'company.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('returns storage failures and rejects symlinks, invalid slugs and forged identity', async () => {
        await expect(store.savePage('../escape', page('bad'))).rejects.toBeDefined()
        await expect(store.savePage('company', { ...page('bad'), author: 'agent:forged' })).rejects.toBeDefined()
        await writeFile(join(root, 'private.md'), 'private')
        await symlink(join(root, 'private.md'), join(directory, 'company.md'))
        await expect(store.readPage('company')).rejects.toBeDefined()
        await rm(directory, { recursive: true })
        await expect(store.listPages()).rejects.toBeDefined()
    })
})

it('exposes only page operations, strict input and mandatory guarded restore', async () => {
    const api = createDesktopBrainPagesRouter(async () => store)
    const put = (body: unknown) => api.request('/company', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await put({ ...page('forged'), author: 'user:someone' })).status).toBe(400)
    const response = await put(page('saved'))
    expect(response.status).toBe(200)
    const saved = await response.json()
    expect(saved.page.updatedBy).toBe(DESKTOP_BRAIN_AUTHOR)
    expect((await api.request(`/company/revert/${saved.revisions[0].id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400)
    expect((await api.request('/company/revisions')).status).toBe(200)
    expect((await api.request('/company/revisions/missing')).status).toBe(404)
    expect((await api.request('/seed', { method: 'POST' })).status).toBe(404)
    expect((await api.request('/company', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...page('x'), padding: 'x'.repeat(300_001) }) })).status).toBe(413)
    await rm(directory, { recursive: true })
    expect((await api.request('/')).status).toBe(503)
})

it('allows only canonical human page paths without opening hosted Brain or seed endpoints', () => {
    expect(desktopBrainPagesRouteAllowed('GET', '/desktop/brain/pages')).toBe(true)
    expect(desktopBrainPagesRouteAllowed('PUT', '/desktop/brain/pages/company')).toBe(true)
    expect(desktopBrainPagesRouteAllowed('POST', '/desktop/brain/pages/company/revert/revision')).toBe(true)
    for (const path of ['/brain/pages', '/brain/seed', '/desktop/brain/seed', '/desktop/brain/pages/../memories', '/desktop/brain/pages/%2e%2e', `/desktop/brain/pages/${'a'.repeat(65)}`]) {
        expect(desktopBrainPagesRouteAllowed('GET', path)).toBe(false)
    }
    expect(desktopBrainPagesRouteAllowed('POST', '/desktop/brain/pages/seed')).toBe(false)
})
