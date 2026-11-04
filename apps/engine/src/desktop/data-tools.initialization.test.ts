import { createClient } from '@libsql/client'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'desktop-data-first-call-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const state = vi.hoisted(() => ({ config: { name: 'First call fixture', enabled: true, tools: { desktopToolGrants: { db: true, sharedDb: true } } } }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: vi.fn(async () => state.config) }))
const { desktopDbTools, desktopSharedDbTools } = await import('./data-tools.js')
const { readAgentConfig } = await import('../agents/loader.js')
const { withAgentLock } = await import('../agents/lock.js')
const { SHARED_DB_VERSION } = await import('../db/sharedDb.js')
let sequence = 0
const cleanup: string[] = []
const context = (id: string, signal?: AbortSignal) => ({ agent: { id, config: state.config }, abortSignal: signal } as unknown as RunContext)

async function run(tools: ToolSet, name: string, args: Record<string, unknown>): Promise<string> {
    const tool = tools[name] as unknown as { inputSchema: { parse: (value: unknown) => unknown }; execute: (input: unknown, options: unknown) => Promise<unknown> }
    return String(await tool.execute(tool.inputSchema.parse(args), { toolCallId: 'first-call', messages: [] }))
}
async function database(file: string) {
    await mkdir(dirname(file), { recursive: true })
    const client = createClient({ url: `file:${file}` })
    try {
        await client.execute('PRAGMA journal_mode = DELETE')
        await client.execute('CREATE TABLE original (value TEXT)')
        await client.execute("INSERT INTO original VALUES ('untouched')")
    } finally { client.close() }
}
afterEach(async () => {
    for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
    vi.mocked(readAgentConfig).mockClear()
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

it.each(['private', 'shared'] as const)('first %s tool call rejects a symlinked parent without touching the target database', async scope => {
    const id = `parent-${++sequence}`
    const external = mkdtempSync(join(tmpdir(), 'desktop-data-victim-'))
    cleanup.push(external)
    const parent = scope === 'private' ? join(root, 'agents', id, 'data') : join(root, 'shared-db')
    const target = join(external, scope === 'private' ? 'agent.db' : 'shared.db')
    await database(target)
    const before = await readFile(target)
    await mkdir(dirname(parent), { recursive: true })
    await symlink(external, parent)
    cleanup.push(scope === 'private' ? join(root, 'agents', id) : parent)
    const tools = scope === 'private' ? desktopDbTools(context(id)) : desktopSharedDbTools(context(id))
    await expect(run(tools, scope === 'private' ? 'db_query' : 'shared_db_query', { sql: 'SELECT 1' })).rejects.toThrow('Unsafe database directory')
    expect(await readFile(target)).toEqual(before)
    expect(await readdir(external)).toEqual([scope === 'private' ? 'agent.db' : 'shared.db'])
})

it.each(['private', 'shared'] as const)('first %s tool call rejects a symlinked main file before SQLite initialization', async scope => {
    const id = `file-${++sequence}`
    const external = mkdtempSync(join(tmpdir(), 'desktop-data-victim-'))
    cleanup.push(external)
    const parent = scope === 'private' ? join(root, 'agents', id, 'data') : join(root, 'shared-db')
    await mkdir(parent, { recursive: true })
    cleanup.push(scope === 'private' ? join(root, 'agents', id) : parent)
    const target = join(external, 'victim.sqlite')
    await database(target)
    const before = await readFile(target)
    await symlink(target, join(parent, scope === 'private' ? 'agent.db' : 'shared.db'))
    const tools = scope === 'private' ? desktopDbTools(context(id)) : desktopSharedDbTools(context(id))
    await expect(run(tools, scope === 'private' ? 'db_schema' : 'shared_db_schema', {})).rejects.toThrow('Unsafe database file')
    expect(await readFile(target)).toEqual(before)
    expect(await readdir(external)).toEqual(['victim.sqlite'])
})

it.each(['-wal', '-shm', '-journal'])('first private call rejects a symlinked %s before changing the existing main file or target', async suffix => {
    const id = `journal-${++sequence}`
    const parent = join(root, 'agents', id, 'data')
    cleanup.push(join(root, 'agents', id))
    const file = join(parent, 'agent.db')
    await database(file)
    const before = await readFile(file)
    const target = join(root, `journal-victim-${sequence}`)
    cleanup.push(target)
    await writeFile(target, 'Do not change this journal target')
    await symlink(target, file + suffix)
    await expect(run(desktopDbTools(context(id)), 'db_query', { sql: 'SELECT 1' })).rejects.toThrow('Unsafe database journal')
    expect(await readFile(file)).toEqual(before)
    expect(await readFile(target, 'utf8')).toBe('Do not change this journal target')
})

it('first shared call rejects a dangling journal before even creating the main database', async () => {
    const parent = join(root, 'shared-db')
    cleanup.push(parent)
    await mkdir(parent)
    const target = join(root, 'missing-journal-target')
    await symlink(target, join(parent, 'shared.db-wal'))
    await expect(run(desktopSharedDbTools(context('shared-journal')), 'shared_db_query', { sql: 'SELECT 1' })).rejects.toThrow('Unsafe database journal')
    expect(existsSync(join(parent, 'shared.db'))).toBe(false)
    expect(existsSync(target)).toBe(false)
})

it('initializes fresh ordinary private/shared files in the worker and preserves shared baseline metadata', async () => {
    const id = `fresh-${++sequence}`
    const privateFile = join(root, 'agents', id, 'data', 'agent.db')
    const sharedFile = join(root, 'shared-db', 'shared.db')
    cleanup.push(join(root, 'agents', id), join(root, 'shared-db'))
    expect(existsSync(privateFile)).toBe(false)
    expect(existsSync(sharedFile)).toBe(false)
    for (const scope of ['private', 'shared'] as const) {
        const tools = scope === 'private' ? desktopDbTools(context(id)) : desktopSharedDbTools(context(id))
        const prefix = scope === 'private' ? 'db' : 'shared_db'
        await expect(run(tools, `${prefix}_execute`, { statements: [
            { sql: 'CREATE TABLE records (body TEXT)' },
            { sql: 'INSERT INTO records VALUES (?)', params: [scope] },
        ] })).resolves.toMatch(/^OK, 2 statement/)
        await expect(run(tools, `${prefix}_query`, { sql: 'SELECT body FROM records' })).resolves.toContain(`"${scope}"`)
    }
    const shared = createClient({ url: `file:${sharedFile}` })
    try {
        expect((await shared.execute('PRAGMA user_version')).rows[0].user_version).toBe(SHARED_DB_VERSION)
        expect((await shared.execute("SELECT created_by FROM _rerun_shared_tables WHERE table_name = 'records'")).rows[0].created_by).toBe(state.config.name)
    } finally { shared.close() }
}, 10_000)

it('Stop settles queued B before A releases the agent lock and B never executes afterward', async () => {
    const id = `queued-${++sequence}`
    const file = join(root, 'agents', id, 'data', 'agent.db')
    cleanup.push(join(root, 'agents', id))
    let releaseA!: () => void, markEntered!: () => void
    const entered = new Promise<void>(resolve => { markEntered = resolve })
    const held = withAgentLock(id, async () => {
        markEntered()
        await new Promise<void>(resolve => { releaseA = resolve })
    })
    await entered
    const controller = new AbortController()
    const queued = run(desktopDbTools(context(id, controller.signal)), 'db_execute', { sql: 'CREATE TABLE should_never_exist (n INTEGER)' })
    const settled = queued.then(() => ({ status: 'unexpected success' }), error => ({ status: 'rejected', error }))
    controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const result = await Promise.race([settled, new Promise<{ status: string }>(resolve => { timer = setTimeout(() => resolve({ status: 'still blocked by A' }), 250) })])
        expect(result).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } })
        expect(readAgentConfig).not.toHaveBeenCalled()
        expect(existsSync(file)).toBe(false)
    } finally {
        clearTimeout(timer)
        releaseA()
        await held
        await withAgentLock(id, async () => {})
    }
    expect(readAgentConfig).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
})
