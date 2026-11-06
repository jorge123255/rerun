import { expect, test } from 'vitest'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'
import { logicalCreateTableSql, normalizeTable, normalizeView, packageDigest } from './normalize.ts'

const leads = {
    name: 'leads',
    columns: [
        { name: 'id', type: 'INTEGER', pk: true, notnull: true },
        { name: 'name', type: 'TEXT', pk: false, notnull: true },
        { name: 'score', type: 'REAL', pk: false, notnull: false },
    ],
    rows: [
        { id: 1, name: 'Ada', score: 1.5 },
        { id: 2, name: 'Bea', score: null },
    ],
}

test('normalizes supported schema and values and binds table digest', () => {
    const table = normalizeTable(leads)
    expect(table.columns.map(column => column.type)).toEqual(['INTEGER', 'TEXT', 'REAL'])
    expect(table.tableDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(logicalCreateTableSql(table)).toMatch(/^CREATE TABLE IF NOT EXISTS "leads" \(/)
    expect(logicalCreateTableSql(table)).not.toContain(';')
})

test('rejects internal names, unsupported types, executable SQL keys, and bounds', () => {
    expect(() => normalizeTable({ ...leads, name: 'sqlite_master' })).toThrow(DesktopCoworkerShareDatabaseError)
    expect(() => normalizeTable({ ...leads, name: '_rerun_views' })).toThrow(DesktopCoworkerShareDatabaseError)
    expect(() => normalizeTable({ ...leads, columns: [{ name: 'body', type: 'GEOMETRY', pk: false, notnull: false }], rows: [] })).toThrow(DesktopCoworkerShareDatabaseError)
    expect(() => normalizeTable({ ...leads, rows: [{ id: 1, name: 'Ada', score: 1, sql: 'DROP TABLE leads' }] })).toThrow(DesktopCoworkerShareDatabaseError)
    expect(() => normalizeTable({ ...leads, rows: [{ id: 1, name: 'x'.repeat(9000), score: null }] })).toThrow(DesktopCoworkerShareDatabaseError)
})

test('normalizes saved views bound to included tables only', () => {
    const table = normalizeTable(leads)
    const view = normalizeView({
        id: 'view-1',
        table: 'leads',
        name: 'Hot',
        position: 0,
        config: { layout: 'table', columns: ['name', 'score'], sort: { column: 'score', dir: 'desc' } },
    }, new Set([table.name]))
    expect(view.viewDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(() => normalizeView({
        id: 'view-2',
        table: 'missing',
        name: 'Gone',
        position: 0,
        config: { layout: 'table' },
    }, new Set([table.name]))).toThrow(DesktopCoworkerShareDatabaseError)
    expect(packageDigest([table], [view])).toMatch(/^[a-f0-9]{64}$/)
})
