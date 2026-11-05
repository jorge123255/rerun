import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import type { RunContext } from '../runtime/context.js'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-desktop-card-table-'))
process.env.RERUN_API_KEY = ''

// Both permissions are read again immediately before and after the worker runs, so a change the
// user makes while a card is being drawn must decide the next call, not the one already prepared.
const state = vi.hoisted(() => ({ config: { enabled: true, tools: { desktopToolGrants: {} as Record<string, boolean | undefined> } } }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => state.config }))

const { desktopTableCardTools } = await import('./card-table.js')
const { getAgentDb } = await import('../db/agentDb.js')
const { getSharedDb } = await import('../db/sharedDb.js')
const { saveView } = await import('../db/tableViews.js')
const { tableCardSchema } = await import('@rerun/contracts')

const AGENT = 'card-table-agent'
const ctx = () => ({ agent: { id: AGENT, name: 'Card Tester', config: state.config }, abortSignal: undefined } as unknown as RunContext)
const grant = (grants: Record<string, boolean>) => { state.config = { enabled: true, tools: { desktopToolGrants: { ...grants } } } }
const cardTableAllowed = (config: { tools: { desktopToolGrants?: Record<string, unknown> } }) => config.tools.desktopToolGrants?.cardTable === true
const cardTools = (signal?: AbortSignal) => {
    const context = ctx()
    if (signal) context.abortSignal = signal
    return desktopTableCardTools(context, cardTableAllowed)
}

async function run(tools: ToolSet, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const found = tools[name]
    if (!found) throw new Error(`missing tool ${name}`)
    const executable = found as unknown as { inputSchema: { parse: (value: unknown) => unknown }; execute: (input: unknown, options: unknown) => Promise<unknown> }
    return String(await executable.execute(executable.inputSchema.parse(args), { toolCallId: 'card-table', messages: [] }))
}

const card = async (tools: ToolSet, args: Record<string, unknown>) => tableCardSchema.parse(JSON.parse(await run(tools, 'card_table', args)))

beforeAll(async () => {
    const db = await getAgentDb(AGENT)
    await db.execute('CREATE TABLE IF NOT EXISTS deals (name TEXT, stage TEXT, amount INTEGER)')
    for (let n = 1; n <= 25; n++) {
        await db.execute({ sql: 'INSERT INTO deals (name, stage, amount) VALUES (?, ?, ?)', args: [`Deal ${n}`, n % 2 ? 'Won' : 'Open', n * 100] })
    }
    await saveView(db, 'deals', {
        name: 'Pipeline', layout: 'board', groupBy: 'stage',
        fields: { title: 'name', value: 'amount' }, formats: { amount: 'currency:USD' },
    })
    await saveView(db, 'deals', { name: 'Names', layout: 'list', fields: { title: 'name' } })
    await db.execute('CREATE TABLE IF NOT EXISTS bare (value TEXT)')

    const shared = await getSharedDb()
    await shared.execute('CREATE TABLE IF NOT EXISTS notes (body TEXT)')
    await shared.execute({ sql: 'INSERT INTO notes (body) VALUES (?)', args: ['shared note'] })
    await saveView(shared, 'notes', { name: 'All', layout: 'list', fields: { title: 'body' } })
})

it('leaves result cards off until root authorizes them, and needs the database grant too', async () => {
    grant({ db: true })
    expect(Object.keys(desktopTableCardTools(ctx(), () => false))).toEqual([])
    expect(Object.keys(desktopTableCardTools(ctx()))).toEqual([])

    expect(Object.keys(desktopTableCardTools(ctx(), cardTableAllowed))).toEqual([])

    grant({ cardTable: true })
    expect(Object.keys(desktopTableCardTools(ctx(), cardTableAllowed))).toEqual(['card_table'])
    await expect(run(cardTools(), 'card_table', { scope: 'agent', table: 'deals', view: 'Pipeline' })).rejects.toThrow('Could not show that table: This database is turned off for this coworker.')

    grant({ cardTable: true, sharedDb: true })
    await expect(run(cardTools(), 'card_table', { scope: 'agent', table: 'deals', view: 'Pipeline' })).rejects.toThrow('Could not show that table: This database is turned off for this coworker.')
    expect((await card(cardTools(), { scope: 'shared', table: 'notes', view: 'All' })).scope).toBe('shared')
})

it('draws a saved private view and freezes only its rows, with no rowid and no view machinery', async () => {
    grant({ cardTable: true, db: true })
    const drawn = await card(cardTools(), { scope: 'agent', table: 'deals', view: 'Pipeline' })
    expect(drawn).toMatchObject({ kind: 'table', scope: 'agent', table: 'deals', view: 'Pipeline', layout: 'board', groupBy: 'stage', total: 25 })
    expect(drawn.groups?.length).toBe(2)
    expect(drawn.rows.length).toBeGreaterThan(0)
    expect(drawn.rows.length).toBeLessThanOrEqual(20)
    // Original buildTableCard orders semantic fields first, followed by groupBy.
    expect(drawn.columns).toEqual(['name', 'amount', 'stage'])
    expect(drawn.rows.every(row => Object.keys(row).sort().join(',') === 'amount,name,stage')).toBe(true)

    const listed = await card(cardTools(), { scope: 'agent', table: 'deals', view: 'names' })
    expect(listed).toMatchObject({ layout: 'list', view: 'Names', total: 25 })
    expect(listed.rows.length).toBe(5)
})

it('reports a missing view by name instead of drawing a different one', async () => {
    grant({ cardTable: true, db: true })
    const missing = await run(cardTools(), 'card_table', { scope: 'agent', table: 'deals', view: 'Ghost' }).catch(error => (error as Error).message)
    expect(missing).toContain('Could not show that table: No view named "Ghost" on deals. Its views: ')
    expect(missing).toContain('Pipeline')

    const unviewed = await run(cardTools(), 'card_table', { scope: 'agent', table: 'bare', view: 'All' }).catch(error => (error as Error).message)
    expect(unviewed).toContain('bare has no saved view yet')
    expect(unviewed).toContain('database view editor')
})

it('refuses hidden tables and unknown tables without reaching SQL', async () => {
    grant({ cardTable: true, db: true })
    await expect(run(cardTools(), 'card_table', { scope: 'agent', table: '_rerun_views', view: 'All' })).rejects.toThrow('Could not show that table: Table not found: _rerun_views')
    await expect(run(cardTools(), 'card_table', { scope: 'agent', table: 'no_such_table', view: 'All' })).rejects.toThrow('Could not show that table: Table not found: no_such_table')
})

it('bounds the limit at the renderer bound', () => {
    grant({ cardTable: true, db: true })
    const tool = cardTools().card_table as unknown as { inputSchema: { parse: (value: unknown) => unknown } }
    expect(() => tool.inputSchema.parse({ scope: 'agent', table: 'deals', view: 'Pipeline', limit: 21 })).toThrow()
    expect(() => tool.inputSchema.parse({ scope: 'agent', table: 'deals' })).toThrow()
})

it('follows a permission revoked after the tools were prepared', async () => {
    grant({ cardTable: true, db: true })
    const tools = cardTools()
    expect(Object.keys(tools)).toEqual(['card_table'])

    grant({ cardTable: false, db: true })
    await expect(run(tools, 'card_table', { scope: 'agent', table: 'deals', view: 'Pipeline' })).rejects.toThrow('Could not show that table: Result cards are turned off for this coworker.')

    grant({ cardTable: true, db: false })
    await expect(run(tools, 'card_table', { scope: 'agent', table: 'deals', view: 'Pipeline' })).rejects.toThrow('Could not show that table: This database is turned off for this coworker.')
})

it('propagates Stop as cancellation instead of a successful failure string', async () => {
    grant({ cardTable: true, db: true })
    const controller = new AbortController()
    controller.abort()
    await expect(run(cardTools(controller.signal), 'card_table', { scope: 'agent', table: 'deals', view: 'Pipeline' })).rejects.toMatchObject({ name: 'AbortError' })
})

it('keeps long ordinary text within the recorded card bound, including its ellipsis', async () => {
    grant({ cardTable: true, db: true })
    const db = await getAgentDb(AGENT)
    await db.execute('CREATE TABLE long_notes (body TEXT)')
    await db.execute({ sql: 'INSERT INTO long_notes VALUES (?)', args: ['x'.repeat(500)] })
    await saveView(db, 'long_notes', { name: 'Notes', layout: 'list', fields: { title: 'body' } })
    const drawn = await card(cardTools(), { scope: 'agent', table: 'long_notes', view: 'Notes' })
    expect(drawn.rows).toEqual([{ body: `${'x'.repeat(119)}…` }])
})

it('uses the same plain-schema refusal as database reads, even for an ordinary target table', async () => {
    grant({ cardTable: true, db: true })
    const db = await getAgentDb(AGENT)
    await db.execute('CREATE VIEW forbidden_program AS SELECT * FROM deals')
    try {
        await expect(run(cardTools(), 'card_table', { scope: 'agent', table: 'deals', view: 'Names' }))
            .rejects.toThrow('Views, triggers and virtual tables are unavailable in desktop data tools.')
    } finally { await db.execute('DROP VIEW forbidden_program') }
    expect((await card(cardTools(), { scope: 'agent', table: 'deals', view: 'Names' })).view).toBe('Names')
})
