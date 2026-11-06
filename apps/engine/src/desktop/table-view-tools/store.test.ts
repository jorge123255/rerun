import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listViews, saveView } from '../../db/tableViews.js'
import { deleteDesktopTableView, DesktopTableViewCommitUnknownError, DesktopTableViewConflictError, saveDesktopTableView } from './store'

let db: Client
beforeEach(async () => {
    db = createClient({ url: 'file::memory:' })
    await db.execute('CREATE TABLE deals (name TEXT, stage TEXT, amount INTEGER)')
    await db.execute("INSERT INTO deals VALUES ('A', 'New', 100), ('B', 'Won', 300)")
})
afterEach(() => { db.close() })

const scope = () => ({ client: db, hidden: [], table: 'deals' })

describe('validated production table-view store', () => {
    it('saves through the canonical tableViews authority without touching rows', async () => {
        const view = await saveDesktopTableView({ ...scope(), input: { name: 'Pipeline', layout: 'board', groupBy: 'stage', fields: { title: 'name' } } })
        expect(view.layout).toBe('board')
        expect((await listViews(db, 'deals')).map(row => row.name)).toEqual(['Pipeline'])
        expect(Number((await db.execute('SELECT count(*) AS total FROM deals')).rows[0].total)).toBe(2)
    })

    it('validates columns and layout before any view write', async () => {
        await expect(saveDesktopTableView({ ...scope(), input: { name: 'Bad', layout: 'list', fields: { title: 'missing' } } })).rejects.toThrow('Unknown column')
        await expect(saveDesktopTableView({ ...scope(), input: { name: 'Bad', layout: 'board', fields: { title: 'name' } } })).rejects.toThrow('needs groupBy')
        expect(await listViews(db, 'deals')).toEqual([])
    })

    it('replaces the same view identity and reports a concurrent human edit instead of overwriting it', async () => {
        await saveView(db, 'deals', { name: 'Pipeline', layout: 'table', columns: ['name'] })
        const replaced = await saveDesktopTableView({ ...scope(), input: { name: 'Pipeline', layout: 'list', fields: { title: 'name' } } })
        expect(replaced.layout).toBe('list')
        expect((await listViews(db, 'deals')).length).toBe(1)
        await expect(saveDesktopTableView({
            ...scope(), input: { name: 'Pipeline', layout: 'table', columns: ['amount'] },
            beforeTransaction: async () => { await saveView(db, 'deals', { name: 'Pipeline', layout: 'table', columns: ['stage'] }, { replaceByName: true }) },
        })).rejects.toBeInstanceOf(DesktopTableViewConflictError)
        expect((await listViews(db, 'deals'))[0].columns).toEqual(['stage'])
    })

    it('deletes only the named view and preserves table rows and sibling views', async () => {
        await saveView(db, 'deals', { name: 'Pipeline', layout: 'table' })
        await saveView(db, 'deals', { name: 'People', layout: 'list', fields: { title: 'name' } })
        expect(await deleteDesktopTableView({ ...scope(), name: 'Pipeline' })).toBe(true)
        expect((await listViews(db, 'deals')).map(row => row.name)).toEqual(['People'])
        expect(Number((await db.execute('SELECT count(*) AS total FROM deals')).rows[0].total)).toBe(2)
        expect(await deleteDesktopTableView({ ...scope(), name: 'Pipeline' })).toBe(false)
    })

    it('reports post-commit authorization loss as unknown without reversing or repeating the effect', async () => {
        let calls = 0
        await expect(saveDesktopTableView({
            ...scope(), input: { name: 'Pipeline', layout: 'table' },
            afterCommit: async () => { calls++; throw new Error('stop') },
        })).rejects.toBeInstanceOf(DesktopTableViewCommitUnknownError)
        expect(calls).toBe(1)
        expect((await listViews(db, 'deals')).map(row => row.name)).toEqual(['Pipeline'])
        expect(Number((await db.execute('SELECT count(*) AS total FROM deals')).rows[0].total)).toBe(2)
    })

    it('refuses internal table identities', async () => {
        await expect(saveDesktopTableView({ ...scope(), table: '_rerun_views', input: { name: 'Bad', layout: 'table' } })).rejects.toThrow('Table not found')
    })
})
