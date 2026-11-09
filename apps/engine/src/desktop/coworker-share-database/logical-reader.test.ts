import { createClient, type Client } from '@libsql/client'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { saveView } from '../../db/tableViews.ts'
import { captureLogicalPrivateDatabase } from './logical-reader.ts'
import { verifyReviewedPrivateDatabase } from './verify.ts'
import { previewDesktopCoworkerShareDatabase } from './preview.ts'

let directory = '', client: Client
const identity = { workspaceId: 7,agentId: 'local-coworker',requestId: 'review-1' }
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(),'logical-db-capture-'))); client = createClient({ url: `file:${join(directory,'agent.db')}` }) })
afterEach(async () => { client.close(); await rm(directory,{ recursive: true,force: true }) })

async function fixture() {
    await client.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, payload BLOB)')
    await client.execute({ sql: 'INSERT INTO notes VALUES (?,?,?)',args: [1,'Keep 世界',Buffer.from([0,1,255])] })
    await saveView(client,'notes',{ name: 'All',layout: 'table',columns: ['title','id'] })
}
const capture = () => captureLogicalPrivateDatabase(client,identity)
const verify = (pkg: Awaited<ReturnType<typeof capture>>) => verifyReviewedPrivateDatabase(pkg,{ sourceWorkspaceId: 7,sourceAgentId: identity.agentId,captureRequestId: identity.requestId,expectedDigest: pkg.digest })

test('reuses the logical package for Unicode/BLOBs and exact saved views; hidden table data is excluded', async () => {
    await fixture()
    await client.execute('CREATE TABLE _rerun_internal (secret TEXT)')
    await client.execute("INSERT INTO _rerun_internal VALUES ('INTERNAL_DATA_SENTINEL')")
    const pkg = await capture(), review = previewDesktopCoworkerShareDatabase(pkg.tables,pkg.views)
    expect(pkg.tables.map(table => table.name)).toEqual(['notes'])
    expect(pkg.tables[0]!.rows[0]).toEqual({ id: 1,title: 'Keep 世界',payload: { encoding: 'base64',bytes: 3,data: 'AAH/' } })
    expect(pkg.views[0]).toMatchObject({ table: 'notes',name: 'All',config: { layout: 'table',columns: ['title','id'] } })
    expect(review.contents).toEqual(pkg.contents); expect(review.viewCount).toBe(1); expect(review.digest).toBe(pkg.digest)
    expect(JSON.stringify(pkg)).not.toContain('INTERNAL_DATA_SENTINEL')
    expect(verify(pkg)).toEqual(pkg)
    expect((await client.execute('SELECT count(*) AS n FROM _rerun_views')).rows[0]!.n).toBe(1)
})

test('data and view changes produce different digests rather than silently retaining an old review', async () => {
    await fixture()
    const first = await capture()
    await client.execute("UPDATE notes SET title='Changed' WHERE id=1")
    const edited = await capture(); expect(edited.digest).not.toBe(first.digest)
    await client.execute("UPDATE _rerun_views SET name='Renamed'")
    expect((await capture()).digest).not.toBe(edited.digest)
    expect(() => verifyReviewedPrivateDatabase(edited,{ sourceWorkspaceId: 7,sourceAgentId: identity.agentId,captureRequestId: identity.requestId,expectedDigest: first.digest })).toThrow()
})

test.each([
    'CREATE TABLE notes (id INTEGER DEFAULT 1)',
    'CREATE TABLE notes (id INTEGER, title TEXT, PRIMARY KEY (id,title))',
    'CREATE TABLE notes (id INTEGER UNIQUE)',
    'CREATE TABLE notes (id INTEGER CHECK (id > 0))',
    'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT)',
    'CREATE TABLE notes (id BIGINT PRIMARY KEY)',
    'CREATE TABLE notes (id TEXT NOT NULL PRIMARY KEY)',
])('refuses unsupported schema without flattening constraints: %s', async ddl => {
    await client.execute(ddl)
    await expect(capture()).rejects.toThrow()
})

test('SQL views/triggers and secret fields fail closed before any logical payload is returned', async () => {
    await fixture()
    await client.execute('CREATE VIEW not_a_saved_view AS SELECT * FROM notes')
    await expect(capture()).rejects.toThrow()
    await client.execute('DROP VIEW not_a_saved_view')
    await client.execute('CREATE TABLE credentials (value TEXT)')
    await expect(capture()).rejects.toThrow()
})

test('known credential-shaped cell data is refused instead of entering a review payload', async () => {
    await fixture()
    await client.execute({ sql: 'UPDATE notes SET title=?',args: [`Bearer ${'x'.repeat(32)}`] })
    await expect(capture()).rejects.toThrow()
})

test('refuses oversized rows and cells before exporting data', async () => {
    await fixture()
    await client.execute({ sql: 'UPDATE notes SET title=?',args: ['x'.repeat(8193)] })
    await expect(capture()).rejects.toThrow()
    await client.execute("UPDATE notes SET title='Small'")
    await client.execute('WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO notes(id,title) SELECT x,\'Bounded\' FROM n')
    await expect(capture()).rejects.toThrow()
})

test('saved view corruption, missing columns and unknown config keys are errors, never sanitized review counts', async () => {
    await fixture()
    for (const config of ['{invalid',JSON.stringify({ layout: 'table',columns: ['missing'] }),JSON.stringify({ layout: 'invented' }),JSON.stringify({ layout: 'table',extra: 'ignored elsewhere' })]) {
        await client.execute({ sql: 'UPDATE _rerun_views SET config=?',args: [config] })
        await expect(capture()).rejects.toThrow()
    }
})

test('saved view identities are not trimmed into another review identity', async () => {
    await fixture()
    await client.execute("UPDATE _rerun_views SET name=' All '")
    await expect(capture()).rejects.toThrow()
})

test('verification refuses forged counts, duplicate identities, foreign owners, invalid BLOB bytes and tampered view digests', async () => {
    await fixture()
    const pkg = await capture()
    expect(() => verify({ ...pkg,contents: { count: 0,bytes: 0 } })).toThrow()
    expect(() => verify({ ...pkg,tables: [pkg.tables[0]!,pkg.tables[0]!] })).toThrow()
    expect(() => verify({ ...pkg,sourceAgentId: 'other' })).toThrow()
    const blob = structuredClone(pkg); blob.tables[0]!.rows[0]!.payload = { encoding: 'base64',bytes: 999,data: 'AAH/' }
    expect(() => verify(blob)).toThrow()
    const view = structuredClone(pkg); view.views[0]!.viewDigest = '0'.repeat(64)
    expect(() => verify(view)).toThrow()
})
