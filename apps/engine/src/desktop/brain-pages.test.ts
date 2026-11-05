import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
    await store.initialize()
    process.env.RERUN_DESKTOP_APP = '1'
})
afterEach(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
    if (previousMode === undefined) delete process.env.RERUN_DESKTOP_APP
    else process.env.RERUN_DESKTOP_APP = previousMode
    vi.restoreAllMocks()
})
const save = (content: string, hash: string | null = null, id = randomUUID()) => store.savePage('company', page(content, hash), id)

it('writes original Markdown, history, links and local FTS without network', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'))
    const saved = await save('## Work\nLocal facts and [[partner]].')
    expect(saved.page.updatedBy).toBe(DESKTOP_BRAIN_AUTHOR)
    expect(saved.page.links).toEqual(['partner'])
    expect(await readFile(join(directory, 'company.md'), 'utf8')).toContain('type: company')
    expect((await store.search('facts')).hits[0]?.slug).toBe('company')
    expect((await db.execute('SELECT embedding FROM brain_chunks')).rows.every(row => row.embedding === null)).toBe(true)
    expect(network).not.toHaveBeenCalled()
})
it('replays exactly the committed save after reopen and rejects request identity reuse', async () => {
    const id = randomUUID(), first = await save('first', null, id)
    await save('newer', first.page.hash)
    store = createDesktopBrainPagesStore(directory, async () => db)
    await store.initialize()
    expect(await save('first', null, id)).toEqual(first)
    expect((await store.readPage('company')).page.content).toBe('newer')
    await expect(save('different', null, id)).rejects.toMatchObject({ status: 409 })
})
it('serializes competing creates, and binds deletion and confirmations to current hashes', async () => {
    const results = await Promise.allSettled([save('first'), save('second')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const first = await store.readPage('company')
    const second = await save('changed', first.page.hash)
    await expect(store.deletePage('company', first.page.hash, randomUUID())).rejects.toMatchObject({ status: 409 })
    await expect(store.confirmSections('company', null, first.page.hash, randomUUID())).rejects.toMatchObject({ status: 409 })
    const id = randomUUID()
    expect(await store.deletePage('company', second.page.hash, id)).toEqual({ ok: true })
    expect(await store.deletePage('company', second.page.hash, id)).toEqual({ ok: true })
    expect(await store.listPages()).toEqual([])
    expect((await store.readRevision('company', first.revisions[0]!.id)).content).toBe('changed')
})
it('keeps revision identity for autosaves and adds a guarded restore revision', async () => {
    const first = await save('original'), id = first.revisions[0]!.id
    await db.execute({ sql: 'UPDATE brain_revisions SET created_at = ? WHERE id = ?', args: ['2000-01-01T00:00:00.000Z', id] })
    const second = await save('changed', first.page.hash)
    await expect(store.restorePage('company', id, first.page.hash, randomUUID())).rejects.toMatchObject({ status: 409 })
    const requestId = randomUUID()
    const restored = await store.restorePage('company', id, second.page.hash, requestId)
    expect(restored.page.content).toBe('original')
    expect(restored.revisions).toHaveLength(3)
    expect(await store.restorePage('company', id, second.page.hash, requestId)).toEqual(restored)
})
it('recovers a committed publication journal before rebuilding local index', async () => {
    const saved = await save('durable content')
    const raw = await readFile(join(directory, 'company.md'), 'utf8')
    // Crash seam: committed DB decision, but the Markdown rename has not yet happened.
    await db.execute({ sql: 'INSERT INTO desktop_brain_publications(slug, raw) VALUES (?, ?)', args: ['company', raw] })
    await rm(join(directory, 'company.md'))
    store = createDesktopBrainPagesStore(directory, async () => db)
    await store.initialize()
    expect((await store.readPage('company')).page.hash).toBe(saved.page.hash)
    expect((await db.execute('SELECT * FROM desktop_brain_publications')).rows).toEqual([])
})
it('rolls back page/history/receipt together if the revision transaction fails', async () => {
    await db.executeMultiple("CREATE TRIGGER fail_revision BEFORE INSERT ON brain_revisions BEGIN SELECT RAISE(ABORT, 'test revision failure'); END;")
    await expect(save('fails')).rejects.toBeDefined()
    for (const table of ['brain_pages', 'brain_revisions', 'desktop_brain_receipts', 'desktop_brain_publications']) expect((await db.execute(`SELECT * FROM ${table}`)).rows).toEqual([])
    await expect(readFile(join(directory, 'company.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('refuses unsafe page paths and does not disguise unavailable storage as an empty Brain', async () => {
    expect(() => store.savePage('../escape', page('bad'), randomUUID())).toThrow()
    expect(() => store.savePage('company', { ...page('bad'), author: 'agent:forged' }, randomUUID())).toThrow()
    await writeFile(join(root, 'private.md'), 'private')
    await symlink(join(root, 'private.md'), join(directory, 'company.md'))
    await expect(store.readPage('company')).rejects.toBeDefined()
    await rm(directory, { recursive: true })
    await expect(store.listPages()).rejects.toBeDefined()
})
it('reconciles local file edits only at explicit rebuild and keeps history', async () => {
    const first = await save('old facts')
    const raw = await readFile(join(directory, 'company.md'), 'utf8')
    await writeFile(join(directory, 'company.md'), raw.replace('old facts', 'new facts'))
    await expect(store.listPages()).rejects.toMatchObject({ status: 409 })
    expect(await store.rebuildLocalIndex()).toEqual({ indexed: 1 })
    expect((await store.readPage('company')).page.content).toBe('new facts')
    expect((await store.readRevision('company', first.revisions[0]!.id)).content).toBe('old facts')
})
it('requires receipt identities, guarded DELETE and original strict schemas on HTTP', async () => {
    const api = createDesktopBrainPagesRouter(async () => store)
    const put = (body: unknown) => api.request('/company', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await put(page('unguarded'))).status).toBe(400)
    expect((await put({ ...page('forged'), author: 'user:someone', requestId: randomUUID() })).status).toBe(400)
    const response = await put({ ...page('saved'), requestId: randomUUID() })
    expect(response.status).toBe(200)
    expect((await api.request('/company', { method: 'DELETE' })).status).toBe(415)
    expect((await api.request('/company/revisions/missing')).status).toBe(404)
    expect((await put({ ...page('x'), requestId: randomUUID(), padding: 'x'.repeat(300_001) })).status).toBe(413)
})
it('allows only canonical desktop page routes', () => {
    expect(desktopBrainPagesRouteAllowed('GET', '/desktop/brain/pages')).toBe(true)
    expect(desktopBrainPagesRouteAllowed('PUT', '/desktop/brain/pages/company')).toBe(true)
    for (const path of ['/brain/pages', '/brain/seed', '/desktop/brain/seed', '/desktop/brain/pages/../memories', '/desktop/brain/pages/%2e%2e']) expect(desktopBrainPagesRouteAllowed('GET', path)).toBe(false)
})
