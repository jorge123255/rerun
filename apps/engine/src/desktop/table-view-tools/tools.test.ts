import { createClient } from '@libsql/client'
import { link, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TableView } from '@rerun/contracts'
import { clearCachedEnvForTests } from '../../config/env.js'
import { closeAgentDb } from '../../db/agentDb.js'
import { desktopTableViewTools } from './tools'

const config = { current: null as any }
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: async () => config.current }))

const ctx = () => ({ agent: { id: 'agent-views', config: config.current }, abortSignal: new AbortController().signal }) as any
const view: TableView = { id: 'view-1', table: 'deals', name: 'Pipeline', position: 0, layout: 'table' }

beforeEach(() => {
    config.current = { enabled: true, tools: { desktopToolGrants: { db: true, sharedDb: true, tableViewWrite: true } } }
})

function adapters() {
    const calls: string[] = []
    return {
        calls,
        save: async (_ctx: unknown, scope: string, input: Record<string, unknown>) => { calls.push(`save:${scope}:${input.name}`); return view },
        delete: async (_ctx: unknown, scope: string, table: string, name: string) => { calls.push(`delete:${scope}:${table}:${name}`); return true },
    }
}

async function withTemporaryDatabase(run: (root: string, file: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'desktop-table-view-admission-'))
    const previous = process.env.RERUN_DATA_DIR
    process.env.RERUN_DATA_DIR = root
    clearCachedEnvForTests()
    const file = join(root, 'agents', 'agent-views', 'data', 'agent.db')
    try {
        await mkdir(dirname(file), { recursive: true })
        await run(root, file)
    } finally {
        closeAgentDb('agent-views')
        if (previous === undefined) delete process.env.RERUN_DATA_DIR
        else process.env.RERUN_DATA_DIR = previous
        clearCachedEnvForTests()
        await rm(root, { recursive: true, force: true })
    }
}

describe('desktop table view tools', () => {
    it('registers nothing without the explicit view-write grant', () => {
        expect(desktopTableViewTools(ctx())).toEqual({})
    })

    it('requires the current view-write and matching scope grants at execution', async () => {
        const allowed = desktopTableViewTools(ctx(), () => true, adapters())
        config.current.tools.desktopToolGrants.db = false
        await expect((allowed.table_view_save as any).execute({ scope: 'agent', table: 'deals', name: 'Pipeline', layout: 'table' }, {})).rejects.toThrow('database is turned off')
        config.current.tools.desktopToolGrants.db = true
        config.current.enabled = false
        await expect((allowed.table_view_delete as any).execute({ scope: 'agent', table: 'deals', name: 'Pipeline' }, {})).rejects.toThrow('turned off')
    })

    it('uses the original save/delete result text and exact scope identity', async () => {
        const ports = adapters()
        const tools = desktopTableViewTools(ctx(), () => true, ports)
        expect(await (tools.table_view_save as any).execute({ scope: 'shared', table: 'deals', name: 'Pipeline', layout: 'table' }, {})).toContain('Saved the table view "Pipeline" on deals')
        expect(await (tools.table_view_delete as any).execute({ scope: 'agent', table: 'deals', name: 'Pipeline' }, {})).toBe('Deleted the view "Pipeline" of deals.')
        expect(ports.calls).toEqual(['save:shared:Pipeline', 'delete:agent:deals:Pipeline'])
    })

    it('preserves the original missing-view outcome without deleting rows', async () => {
        const ports = { ...adapters(), delete: async () => false }
        const tools = desktopTableViewTools(ctx(), () => true, ports)
        expect(await (tools.table_view_delete as any).execute({ scope: 'agent', table: 'deals', name: 'Ghost' }, {})).toBe('deals has no view named "Ghost".')
    })

    it.each([['symbolic', symlink], ['hard', link]] as const)('refuses a %s link before opening the private database', async (_kind, createLink) => {
        await withTemporaryDatabase(async (root, expected) => {
            const target = join(root, 'sibling.db')
            const sibling = createClient({ url: `file:${target}` })
            try {
                await sibling.execute('CREATE TABLE deals (name TEXT)')
                await createLink(target, expected)
                const tools = desktopTableViewTools(ctx(), () => true)
                await expect((tools.table_view_save as any).execute({ scope: 'agent', table: 'deals', name: 'Unsafe', layout: 'table' }, {}))
                    .rejects.toThrow('Unsafe database file.')
                const { rows } = await sibling.execute("SELECT name FROM sqlite_schema WHERE name = '_rerun_views'")
                expect(rows).toEqual([])
            } finally { sibling.close() }
        })
    })

    it('saves and deletes the named view in the canonical private database without changing its rows', async () => {
        await withTemporaryDatabase(async (_root, file) => {
            const db = createClient({ url: `file:${file}` })
            try {
                await db.executeMultiple("CREATE TABLE deals (name TEXT); INSERT INTO deals VALUES ('fixture deal');")
                const tools = desktopTableViewTools(ctx(), () => true)
                const input = { scope: 'agent', table: 'deals', name: 'Pipeline' }
                expect(await (tools.table_view_save as any).execute({ ...input, layout: 'table' }, {})).toContain('Saved the table view')
                expect((await db.execute('SELECT name FROM _rerun_views')).rows.map(row => row.name)).toEqual(['Pipeline'])
                expect(await (tools.table_view_delete as any).execute(input, {})).toContain('Deleted the view')
                expect((await db.execute('SELECT name FROM _rerun_views')).rows).toEqual([])
                expect((await db.execute('SELECT name FROM deals')).rows.map(row => row.name)).toEqual(['fixture deal'])
            } finally { db.close() }
        })
    })
})
