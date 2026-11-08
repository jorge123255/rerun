import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { clearCachedEnvForTests } from '../config/env.js'
import type { RunContext } from '../runtime/context.js'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-desktop-data-tools-'))
process.env.RERUN_API_KEY = ''
clearCachedEnvForTests()

// The grant is read from the saved config immediately before every statement, so the test owns the
// config a permission change would write: flipping it mid-test must change the next call.
const state = vi.hoisted(() => ({ config: { enabled: true, tools: { desktopToolGrants: {} as Record<string, boolean | undefined> } } }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => state.config }))

const { desktopDbTools, desktopSharedDbTools } = await import('./data-tools.js')

const ctx = () => ({ agent: { id: 'data-tools-agent', name: 'Data Tester', config: state.config }, abortSignal: undefined } as unknown as RunContext)

function grant(grants: Record<string, boolean>) {
    state.config = { enabled: true, tools: { desktopToolGrants: { ...grants } } }
}

async function run(tools: ToolSet, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const found = tools[name]
    if (!found) throw new Error(`missing tool ${name}`)
    const executable = found as unknown as { inputSchema: { parse: (value: unknown) => unknown }; execute: (input: unknown, options: unknown) => Promise<unknown> }
    return String(await executable.execute(executable.inputSchema.parse(args), { toolCallId: 'data-tool', messages: [] }))
}

const both = () => ({ ...desktopDbTools(ctx()), ...desktopSharedDbTools(ctx()) })

afterEach(() => grant({}))

it('leaves both databases off by default and opens each grant on its own', () => {
    grant({})
    expect(Object.keys(desktopDbTools(ctx()))).toEqual([])
    expect(Object.keys(desktopSharedDbTools(ctx()))).toEqual([])

    grant({ db: true })
    expect(Object.keys(desktopDbTools(ctx())).sort()).toEqual(['db_execute', 'db_query', 'db_schema'])
    expect(Object.keys(desktopSharedDbTools(ctx()))).toEqual([])

    grant({ sharedDb: true })
    expect(Object.keys(desktopDbTools(ctx()))).toEqual([])
    expect(Object.keys(desktopSharedDbTools(ctx())).sort()).toEqual(['shared_db_execute', 'shared_db_query', 'shared_db_schema'])

    grant({ db: false, sharedDb: true })
    expect(desktopDbTools(ctx()).db_query).toBeUndefined()
    expect(desktopSharedDbTools(ctx()).shared_db_query).toBeDefined()
})

it('keeps the private and shared databases, and their permissions, distinct', async () => {
    grant({ db: true, sharedDb: true })
    const tools = both()

    expect(await run(tools, 'db_execute', { sql: 'CREATE TABLE IF NOT EXISTS notes (body TEXT)' })).toMatch(/^OK, 1 statement/)
    expect(await run(tools, 'db_execute', { sql: "INSERT INTO notes (body) VALUES ('private note')" })).toMatch(/^OK, 1 statement/)
    expect(await run(tools, 'shared_db_execute', { sql: 'CREATE TABLE IF NOT EXISTS notes (body TEXT)' })).toMatch(/^OK, 1 statement/)
    expect(await run(tools, 'shared_db_execute', { sql: "INSERT INTO notes (body) VALUES ('shared note')" })).toMatch(/^OK, 1 statement/)

    expect(await run(tools, 'db_query', { sql: 'SELECT body FROM notes' })).toBe('1 row(s)\n[{"body":"private note"}]')
    expect(await run(tools, 'shared_db_query', { sql: 'SELECT body FROM notes' })).toBe('1 row(s)\n[{"body":"shared note"}]')
    expect(await run(tools, 'db_schema')).toContain('notes')
    expect(await run(tools, 'shared_db_schema')).toContain('notes')
})

it('keeps the upstream write path closed: query-only reads, no ATTACH, PRAGMA, VACUUM or file functions', async () => {
    grant({ db: true, sharedDb: true })
    const tools = both()

    await expect(run(tools, 'db_query', { sql: 'DELETE FROM notes' })).rejects.toThrow(/^Query failed: Only a SELECT/)
    await expect(run(tools, 'db_query', { sql: "SELECT readfile('/etc/passwd') AS v" })).rejects.toThrow('Query failed: File access is not allowed in SQL.')
    await expect(run(tools, 'db_query', { sql: 'SELECT name FROM sqlite_master' })).rejects.toThrow(/^Query failed: Internal tables are not available here/)
    await expect(run(tools, 'db_query', { sql: 'SELECT * FROM _rerun_views' })).rejects.toThrow(/^Query failed: Internal tables are not available here/)
    await expect(run(tools, 'shared_db_query', { sql: 'SELECT * FROM "_rerun_shared_tables"' })).rejects.toThrow(/^Query failed: Internal tables are not available here/)

    await expect(run(tools, 'db_execute', { sql: "ATTACH DATABASE '/tmp/other.db' AS other" })).rejects.toThrow(/^Execution failed:/)
    await expect(run(tools, 'db_execute', { sql: 'PRAGMA writable_schema = 1' })).rejects.toThrow('Execution failed: PRAGMA is not available here.')
    await expect(run(tools, 'db_execute', { sql: 'VACUUM' })).rejects.toThrow('Execution failed: VACUUM is not available here.')
    await expect(run(tools, 'shared_db_execute', { sql: "SELECT writefile('/tmp/pwned', 'x')" })).rejects.toThrow(/^Execution failed:/)

    // A string literal that merely says the words is not a statement.
    expect(await run(tools, 'db_query', { sql: "SELECT 'attach or pragma' AS s" })).toBe('1 row(s)\n[{"s":"attach or pragma"}]')
})

it('refuses a statement when the grant was turned off after the tools were prepared', async () => {
    grant({ db: true })
    const tools = desktopDbTools(ctx())
    expect(Object.keys(tools)).toContain('db_query')

    grant({ db: false })
    await expect(run(tools, 'db_query', { sql: 'SELECT 1 AS one' })).rejects.toThrow('Query failed: This database is turned off for this coworker.')
    await expect(run(tools, 'db_execute', { sql: 'CREATE TABLE later (x TEXT)' })).rejects.toThrow('Execution failed: This database is turned off for this coworker.')
})

it('runs a batch as one transaction and rolls every statement back on a failure', async () => {
    grant({ db: true })
    const tools = desktopDbTools(ctx())
    expect(await run(tools, 'db_execute', { sql: 'CREATE TABLE IF NOT EXISTS batch (n INTEGER NOT NULL)' })).toMatch(/^OK/)

    expect(await run(tools, 'db_execute', { statements: [
        { sql: 'INSERT INTO batch (n) VALUES (?)', params: [1] },
        { sql: 'INSERT INTO batch (n) VALUES (?)', params: [2] },
    ] })).toBe('OK, 2 statement(s), 2 row(s) affected')

    await expect(run(tools, 'db_execute', { statements: [
        { sql: 'INSERT INTO batch (n) VALUES (?)', params: [3] },
        { sql: 'INSERT INTO batch (n) VALUES (NULL)' },
    ] })).rejects.toThrow(/^Execution failed: .*NOT NULL/)

    expect(await run(tools, 'db_query', { sql: 'SELECT count(*) AS c FROM batch' })).toBe('1 row(s)\n[{"c":2}]')
})

it('bounds how many rows a read can return', async () => {
    grant({ db: true })
    const tool = desktopDbTools(ctx()).db_query as unknown as { inputSchema: { parse: (value: unknown) => unknown } }
    expect(() => tool.inputSchema.parse({ sql: 'SELECT 1', limit: 201 })).toThrow()

    const out = await run(desktopDbTools(ctx()), 'db_query', {
        sql: 'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 250) SELECT x FROM r',
        limit: 200,
    })
    expect(out).toContain('[truncated to 200 rows / 50000 characters]')
    expect(out.split('\n')[0]).toBe('200 row(s) returned (additional data omitted)')
})

it('rejects hidden names in SQLite single-quote identifier syntax and rejects schema programs', async () => {
    grant({ db: true })
    const tools = desktopDbTools(ctx())
    await expect(run(tools, 'db_query', { sql: "SELECT * FROM '_rerun_views'" })).rejects.toThrow(/^Query failed: Internal/)
    await expect(run(tools, 'db_execute', { sql: 'CREATE VIEW exposed AS SELECT 1' })).rejects.toThrow(/^Execution failed:/)
    await expect(run(tools, 'db_execute', { sql: 'CREATE TRIGGER bad AFTER INSERT ON notes BEGIN SELECT 1; END' })).rejects.toThrow(/^Execution failed:/)
})

it('rejects ambiguous write inputs before execution', () => {
    grant({ db: true })
    const tool = desktopDbTools(ctx()).db_execute as unknown as { inputSchema: { parse: (value: unknown) => unknown } }
    expect(() => tool.inputSchema.parse({ sql: 'DELETE FROM notes', statements: [{ sql: 'DELETE FROM notes' }] })).toThrow()
    expect(() => tool.inputSchema.parse({ statements: [] })).toThrow()
    expect(() => tool.inputSchema.parse({ sql: 'x'.repeat(20_001) })).toThrow()
})

it('propagates Stop as cancellation instead of a successful failure string', async () => {
    grant({ db: true })
    const aborted = ctx()
    const controller = new AbortController()
    controller.abort()
    aborted.abortSignal = controller.signal
    await expect(run(desktopDbTools(aborted), 'db_query', { sql: 'SELECT 1' })).rejects.toMatchObject({ name: 'AbortError' })
})

it('does not enforce shared table creator metadata as ownership', async () => {
    grant({ sharedDb: true })
    expect(await run(desktopSharedDbTools(ctx()), 'shared_db_execute', { sql: 'CREATE TABLE IF NOT EXISTS collaborator_records (value TEXT)' })).toMatch(/^OK/)
    const other = ctx()
    other.agent.id = 'other-permitted-coworker'
    expect(await run(desktopSharedDbTools(other), 'shared_db_execute', { sql: 'INSERT INTO collaborator_records VALUES (?)', params: ['from another coworker'] })).toMatch(/^OK/)
    expect(await run(desktopSharedDbTools(other), 'shared_db_query', { sql: 'SELECT value FROM collaborator_records' })).toContain('from another coworker')
})
