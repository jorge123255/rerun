import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { createDesktopDataRouter } from './data-router.js'

it('uses explicit atomic operations and keeps internal data and generic SQL closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-data-router-'))
    const db = createClient({ url: `file:${join(root, 'fixture.sqlite')}` })
    try {
        await db.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
        await db.execute("INSERT INTO notes VALUES (1, 'one')")
        const app = new Hono().route('/agents/test/data', createDesktopDataRouter(async () => db))
        const edited = await app.request('/agents/test/data/tables/notes/rows/1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { id: 2, body: 'two' } }) })
        expect(edited.status).toBe(200)
        expect(await edited.json()).toMatchObject({ row: { __rowid: 2, id: 2, body: 'two' } })
        expect((await app.request('/agents/test/data/query', { method: 'POST' })).status).toBe(404)
        expect((await app.request('/agents/test/data/tables/_rerun_views/rows')).status).toBe(404)
        const missing = await app.request('/agents/test/data/tables/notes/rows/999', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { body: 'missing' } }) })
        expect(missing.status).toBe(404)
        const rows = await db.execute('SELECT * FROM notes')
        expect(rows.rows[0]?.body).toBe('two')
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

it('persists saved views through the original helpers and keeps private/shared files distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-data-views-'))
    const privateDb = createClient({ url: `file:${join(root, 'private.sqlite')}` })
    const sharedDb = createClient({ url: `file:${join(root, 'shared.sqlite')}` })
    try {
        for (const db of [privateDb, sharedDb]) await db.execute('CREATE TABLE notes (body TEXT)')
        const app = new Hono()
            .route('/agents/test/data', createDesktopDataRouter(async () => privateDb))
            .route('/shared/data', createDesktopDataRouter(async () => sharedDb))
        const saved = await app.request('/agents/test/data/tables/notes/views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'List', layout: 'list', fields: { title: 'body' } }) })
        expect(saved.status).toBe(200)
        const first = await saved.json() as { view: { id: string } }
        const ownViews = await app.request('/agents/test/data/tables/notes/views')
        expect(await ownViews.json()).toMatchObject({ views: [{ id: first.view.id, name: 'List', layout: 'list' }] })
        const otherViews = await app.request('/shared/data/tables/notes/views')
        expect(await otherViews.json()).toEqual({ views: [] })
        const deleted = await app.request(`/agents/test/data/tables/notes/views/${first.view.id}`, { method: 'DELETE' })
        expect(deleted.status).toBe(204)
        expect(await (await app.request('/agents/test/data/tables/notes/views')).json()).toEqual({ views: [] })
    } finally { privateDb.close(); sharedDb.close(); await rm(root, { recursive: true, force: true }) }
})
