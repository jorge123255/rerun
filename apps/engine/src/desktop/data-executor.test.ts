import { createClient, type Client } from '@libsql/client'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { executeDesktopData, pinDesktopDataFile, type DataOperation, type DataQueryResult } from './data-executor.js'

const fixtures: { root: string; db: Client }[] = []
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'desktop-data-executor-'))
    const file = join(root, 'private.sqlite')
    const db = createClient({ url: `file:${file}` })
    await db.execute('PRAGMA journal_mode = WAL')
    await db.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    fixtures.push({ root, db })
    return { root, file, db }
}
afterEach(async () => {
    for (const item of fixtures.splice(0)) { item.db.close(); await rm(item.root, { recursive: true, force: true }) }
})
const infinite = { kind: 'query', sql: 'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT count(*) FROM r', params: [], hidden: [], limit: 1 } satisfies DataOperation
const insert = (body: string): DataOperation => ({ kind: 'execute', statements: [{ sql: 'INSERT INTO notes (body) VALUES (?)', params: [body] }], hidden: [] })

it('kills a genuinely running recursive aggregate at its deadline without blocking parent timers', async () => {
    const { root, file, db } = await fixture()
    let executing = false, heartbeats = 0
    const heartbeat = setInterval(() => { if (executing) heartbeats++ }, 10)
    try {
        await expect(executeDesktopData(root, file, infinite, { timeoutMs: 3_000, onExecuting: () => { executing = true } })).rejects.toThrow('time limit')
        expect(executing).toBe(true)
        expect(heartbeats).toBeGreaterThan(1)
        // The promise settles only after the worker has exited. Its connection/lock is gone.
        await db.execute("INSERT INTO notes (body) VALUES ('parent still works')")
        expect((await db.execute('SELECT count(*) AS n FROM notes')).rows[0].n).toBe(1)
    } finally { clearInterval(heartbeat) }
}, 8_000)

it('Stop kills executing native SQL promptly and the same database remains usable', async () => {
    const { root, file } = await fixture()
    const abort = new AbortController()
    let executing = false
    let stoppedAt = 0
    await expect(executeDesktopData(root, file, infinite, {
        signal: abort.signal,
        onExecuting: () => { executing = true; setTimeout(() => { stoppedAt = Date.now(); abort.abort() }, 30) },
    })).rejects.toThrow('canceled before commit')
    expect(executing).toBe(true)
    expect(stoppedAt).toBeGreaterThan(0)
    expect(Date.now() - stoppedAt).toBeLessThan(2_000)
    const result = await executeDesktopData(root, file, { kind: 'query', sql: 'SELECT 42 AS answer', params: [], limit: 1, hidden: [] })
    expect(result).toEqual({ rows: [{ answer: 42 }], truncated: false })
}, 8_000)

it('holds a transaction until a fresh grant decision and rolls it back on refusal', async () => {
    const { root, file, db } = await fixture()
    const authorize = vi.fn(async () => { throw new Error('Permission revoked') })
    await expect(executeDesktopData(root, file, insert('must roll back'), { beforeCommit: authorize })).rejects.toThrow('Permission revoked')
    expect(authorize).toHaveBeenCalledOnce()
    expect((await db.execute('SELECT count(*) AS n FROM notes')).rows[0].n).toBe(0)
    await expect(executeDesktopData(root, file, insert('committed'), { beforeCommit: async () => {} }))
        .resolves.toMatchObject({ statements: 1, rowsAffected: 1 })
    expect((await db.execute('SELECT body FROM notes')).rows[0].body).toBe('committed')
}, 8_000)

it('Stop while waiting for final permission kills and rolls back the pending batch', async () => {
    const { root, file, db } = await fixture()
    const abort = new AbortController()
    await expect(executeDesktopData(root, file, insert('canceled'), {
        signal: abort.signal,
        beforeCommit: async () => { abort.abort(); await new Promise(() => {}) },
    })).rejects.toThrow('canceled before commit')
    expect((await db.execute('SELECT count(*) AS n FROM notes')).rows[0].n).toBe(0)
}, 8_000)

it('an invalid later statement rolls back earlier changes and never requests commit', async () => {
    const { root, file, db } = await fixture()
    const authorize = vi.fn(async () => {})
    await expect(executeDesktopData(root, file, {
        kind: 'execute', hidden: [], statements: [
            { sql: 'INSERT INTO notes (body) VALUES (?)', params: ['first'] },
            { sql: 'INSERT INTO notes (body) VALUES (NULL)', params: [] },
        ],
    }, { beforeCommit: authorize })).rejects.toThrow('NOT NULL')
    expect(authorize).not.toHaveBeenCalled()
    expect((await db.execute('SELECT count(*) AS n FROM notes')).rows[0].n).toBe(0)
}, 8_000)

it('returns bounded IPC data and keeps dangerous allocation functions unavailable', async () => {
    const { root, file, db } = await fixture()
    await db.execute({ sql: 'INSERT INTO notes (body) VALUES (?)', args: ['é'.repeat(45_000)] })
    const result = await executeDesktopData(root, file, { kind: 'query', sql: 'SELECT body FROM notes', params: [], hidden: [], limit: 1 }) as DataQueryResult
    expect(result).toEqual({ rows: [], truncated: true })
    await expect(executeDesktopData(root, file, { kind: 'query', sql: "SELECT printf('%1000000000s', 'x')", params: [], hidden: [], limit: 1 })).rejects.toThrow('SQL function is unavailable')
    await expect(executeDesktopData(root, file, { kind: 'query', sql: "WITH RECURSIVE r(x) AS (SELECT 'x' UNION ALL SELECT x || x FROM r) SELECT x FROM r", params: [], hidden: [], limit: 1 })).rejects.toThrow('string concatenation is unavailable')
    await expect(executeDesktopData(root, file, { kind: 'query', sql: 'SELECT ?', params: ['x'.repeat(50_000), ...Array(20).fill('x'.repeat(50_000))], hidden: [], limit: 1 })).rejects.toThrow('exceeds 1 MB')
}, 8_000)

it('refuses paths outside the fixed root and symlinked database files/directories/journals', async () => {
    const { root, file } = await fixture()
    await expect(pinDesktopDataFile(join(root, 'other'), file)).rejects.toThrow('outside')
    await symlink(file, join(root, 'alias.sqlite'))
    await expect(pinDesktopDataFile(root, join(root, 'alias.sqlite'))).rejects.toThrow('Unsafe database file')
    await mkdir(join(root, 'actual'))
    await writeFile(join(root, 'actual', 'data.sqlite'), '')
    await symlink(join(root, 'actual'), join(root, 'linked'))
    await expect(pinDesktopDataFile(root, join(root, 'linked', 'data.sqlite'))).rejects.toThrow('Unsafe database directory')
    const other = join(root, 'journal-target')
    await writeFile(other, '')
    await symlink(other, file + '-journal')
    await expect(pinDesktopDataFile(root, file)).rejects.toThrow('Unsafe database journal')
})
