import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { tool, type ToolSet } from 'ai'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DESKTOP_ACTIVITY_MAX_RECORDS, desktopActivityPageSchema, type DesktopActivityRecord } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-mac-activity-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const { agentDir } = await import('../../config/paths.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { readAgentConfig } = await import('../../agents/loader.js')
const { requireDesktopToolGrant } = await import('../tool-grants.js')
const { ACTIVITY_PRUNE_BATCH, createActivityStore } = await import('./store.js')
const recorder = await import('./recorder.js')
const { buildTools } = await import('../../tools/registry.js')
const { createDesktopActivityRouter, desktopActivityFiltersOf } = await import('./router.js')
const { beginDesktopActivityRun, bindDesktopActivitySink, noteDesktopActivity, recordDesktopActivityTools, recordDesktopProviderCalls, settleDesktopActivity } = recorder

const scout = 'activity-scout'
let client: Client, store: ReturnType<typeof createActivityStore>, n = 0

beforeAll(async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    await mkdir(agentDir(scout), { recursive: true })
})
beforeEach(async () => {
    client = createClient({ url: `file:${join(root, `trail-${++n}.db`)}` })
    store = createActivityStore(client)
    bindDesktopActivitySink(async () => store)
    await writeAgentConfig(scout, agentConfigSchema.parse({ name: scout, tools: { desktopToolGrants: { sharedFilesWrite: true } } }))
})
afterEach(() => { bindDesktopActivitySink(null); client.close() })
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function context(source: Parameters<typeof beginDesktopActivityRun>[1] = 'chat', slug: string | null = null): Promise<RunContext> {
    const ctx = { agent: { id: scout, config: await readAgentConfig(scout) }, sessionId: 'session-1', runId: 'run-1' } as RunContext
    beginDesktopActivityRun(ctx, source, slug)
    return ctx
}
const options = (toolCallId = 'call-1') => ({ messages: [], toolCallId })
const any = z.record(z.string(), z.unknown())
async function run(ctx: RunContext, tools: ToolSet, name: string, input: unknown, isConnector = false): Promise<{ result?: unknown; error?: unknown }> {
    recordDesktopActivityTools(ctx, tools, () => isConnector)
    const execute = tools[name]!.execute as (input: unknown, options: unknown) => Promise<unknown>
    try { return { result: await execute(input, options()) } } catch (error) { return { error } }
}
async function recorded(): Promise<(DesktopActivityRecord & { seq: number })[]> {
    await settleDesktopActivity()
    return (await store.list({})).records
}
const row = (overrides: Partial<DesktopActivityRecord> = {}): DesktopActivityRecord => ({
    id: `row-${++n}`, at: new Date().toISOString(), agentId: scout, sessionId: 's', runId: 'r', source: 'chat', sourceSlug: null, tool: 'fs_read', action: null, app: null, kind: null,
    outcome: 'completed', rule: null, durationMs: 1, summary: null, ...overrides,
})

describe('one record for each outcome, written where the action is decided', () => {
    it('allowed by a permission: the grant check names the permission that let it run', async () => {
        const ctx = await context()
        const tools: ToolSet = { shared_write: tool({ inputSchema: any, execute: async () => { await requireDesktopToolGrant(ctx, 'sharedFilesWrite'); return 'saved' } }) }
        expect(await run(ctx, tools, 'shared_write', { path: 'notes/plan.md', content: 'x'.repeat(5000) })).toEqual({ result: 'saved' })
        const [record] = await recorded()
        expect(record).toMatchObject({ agentId: scout, sessionId: 'session-1', runId: 'run-1', source: 'chat', tool: 'shared_write', outcome: 'allowed-by-permission', rule: 'permission:sharedFilesWrite', kind: null, app: null })
        expect(record!.summary).toBe('path: notes/plan.md, content: [5000 characters]')
        expect(record!.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('refused for a missing permission: the tool fails as before and the row names the switch that is off', async () => {
        const ctx = await context('routine', 'weekly-report')
        await writeAgentConfig(scout, agentConfigSchema.parse({ name: scout, tools: { desktopToolGrants: { sharedFilesWrite: false } } }))
        const tools: ToolSet = { shared_edit: tool({ inputSchema: any, execute: async () => { await requireDesktopToolGrant(ctx, 'sharedFilesWrite'); return 'edited' } }) }
        const { error } = await run(ctx, tools, 'shared_edit', { path: 'a.md' })
        expect(String(error)).toContain('This tool is turned off for this coworker.')
        expect((await recorded())[0]).toMatchObject({ outcome: 'refused-no-permission', rule: 'permission:sharedFilesWrite', source: 'routine', sourceSlug: 'weekly-report' })
    })

    it('allowed once by the person: the app’s decision outranks the permission re-check that follows it', async () => {
        const ctx = await context()
        const tools: ToolSet = { GMAIL_SEND_EMAIL: tool({ inputSchema: any, execute: async () => {
            noteDesktopActivity({ outcome: 'allowed-by-permission', rule: 'permission:mcp' })
            noteDesktopActivity({ outcome: 'allowed-once-by-person', rule: 'ask-first:send', kind: 'send', action: 'GMAIL_SEND_EMAIL' })
            noteDesktopActivity({ outcome: 'allowed-by-permission', rule: 'permission:mcp' })
            return 'sent'
        } }) }
        await run(ctx, tools, 'GMAIL_SEND_EMAIL', { to: 'pat@example.test', body: 'Hello Pat, the quarterly numbers are attached.' }, true)
        const [record] = await recorded()
        expect(record).toMatchObject({ outcome: 'allowed-once-by-person', rule: 'ask-first:send', kind: 'send', app: 'Gmail', action: null })
        expect(record!.summary).toBe(`to: pat@example.test, body: [${'Hello Pat, the quarterly numbers are attached.'.length} characters]`)
    })

    it('a standing answer is kept over the permission that offered the tool', async () => {
        const ctx = await context()
        const tools: ToolSet = { drive_delete_file: tool({ inputSchema: any, execute: async () => {
            noteDesktopActivity({ outcome: 'allowed-by-permission', rule: 'standing-answer:always', kind: 'delete' })
            noteDesktopActivity({ outcome: 'allowed-by-permission', rule: 'permission:mcp' })
            return 'ok'
        } }) }
        await run(ctx, tools, 'drive_delete_file', { id: 'f1' }, true)
        expect((await recorded())[0]).toMatchObject({ outcome: 'allowed-by-permission', rule: 'standing-answer:always', kind: 'delete', app: 'Drive' })
    })

    it('declined by the person, and still waiting for an answer', async () => {
        const ctx = await context()
        const held = (outcome: 'declined-by-person' | 'asked-person') => tool({ inputSchema: any, execute: async () => {
            noteDesktopActivity({ outcome: 'allowed-by-permission', rule: 'permission:mcp' })
            noteDesktopActivity({ outcome, rule: 'ask-first:pay', kind: 'pay' })
            throw new Error('held')
        } })
        const tools: ToolSet = { stripe_refund_charge: held('declined-by-person'), stripe_pay_invoice: held('asked-person') }
        expect((await run(ctx, tools, 'stripe_refund_charge', { amount: 5 }, true)).error).toBeInstanceOf(Error)
        await run(ctx, tools, 'stripe_pay_invoice', { amount: 5 }, true)
        const records = await recorded()
        expect(records.map(record => [record.tool, record.outcome, record.rule, record.kind])).toEqual([
            ['stripe_pay_invoice', 'asked-person', 'ask-first:pay', 'pay'], ['stripe_refund_charge', 'declined-by-person', 'ask-first:pay', 'pay'],
        ])
    })

    it('failed: an allowed call that throws is a failure, with the rule that had allowed it', async () => {
        const ctx = await context()
        const tools: ToolSet = {
            web_fetch: tool({ inputSchema: any, execute: async () => { noteDesktopActivity({ outcome: 'allowed-by-permission', rule: 'permission:webFetch' }); throw new Error('network down') } }),
            plain: tool({ inputSchema: any, execute: () => { throw new Error('sync failure') } }),
        }
        expect(String((await run(ctx, tools, 'web_fetch', { url: 'https://example.test/a' })).error)).toContain('network down')
        expect(String((await run(ctx, tools, 'plain', {})).error)).toContain('sync failure')
        const records = await recorded()
        expect(records.map(record => [record.tool, record.outcome, record.rule])).toEqual([['plain', 'failed', null], ['web_fetch', 'failed', 'permission:webFetch']])
    })

    it('completed: a tool with no permission of its own; a refusal a tool words itself is still a refusal', async () => {
        const ctx = await context()
        const tools: ToolSet = {
            helper_tool: tool({ inputSchema: any, execute: async () => 'ok' }),
            card_table: tool({ inputSchema: any, execute: async () => { throw new Error('Table cards are turned off for this coworker.') } }),
            fs_read: tool({ inputSchema: any, execute: async () => 'text' }),
        }
        await run(ctx, tools, 'helper_tool', {})
        await run(ctx, tools, 'card_table', {})
        await run(ctx, tools, 'fs_read', { path: 'a.md' })
        expect((await recorded()).map(record => [record.tool, record.outcome, record.rule])).toEqual([
            ['fs_read', 'allowed-by-permission', 'permission:workspaceRead'], ['card_table', 'refused-no-permission', 'permission:cardTable'], ['helper_tool', 'completed', null],
        ])
    })

    it('a provider’s own tools are recorded from the step, and a Rerun tool is not recorded twice', async () => {
        const ctx = await context()
        const tools: ToolSet = { fs_read: tool({ inputSchema: any, execute: async () => 'text' }) }
        await run(ctx, tools, 'fs_read', { path: 'a.md' })
        recordDesktopProviderCalls(ctx,
            [{ toolCallId: 'other-id', toolName: 'mcp__rerun__fs_read', input: {} }, { toolCallId: 'p1', toolName: 'Bash', input: { command: 'ls' } }, { toolCallId: 'p2', toolName: 'Edit', input: {} }, { toolCallId: 'p3', toolName: 'ask_user', input: {} }],
            [{ toolCallId: 'p1' }], name => name === 'ask_user')
        recordDesktopProviderCalls(ctx, [{ toolCallId: 'p1', toolName: 'Bash', input: {} }], [{ toolCallId: 'p1' }])
        expect((await recorded()).map(record => [record.tool, record.outcome, record.rule])).toEqual([
            ['ask_user', 'asked-person', 'permission:askUser'], ['Edit', 'failed', 'provider'], ['Bash', 'completed', 'provider'], ['fs_read', 'allowed-by-permission', 'permission:workspaceRead'],
        ])
    })
})

describe('the single point every tool passes', () => {
    it('the registry records the tools it hands a run, and a permission switched off mid-run is a refusal', async () => {
        await writeAgentConfig(scout, agentConfigSchema.parse({ name: scout, tools: { requestApproval: true, desktopToolGrants: { requestApproval: true } } }))
        const ctx = { agent: { id: scout, config: await readAgentConfig(scout) }, sessionId: 'session-9', runId: 'run-9', turnOrder: 'call-first', provider: 'codex', model: 'gpt-6.1-terra', logger: { warn() {}, debug() {}, info() {}, error() {} } } as unknown as RunContext
        beginDesktopActivityRun(ctx, 'trigger', 'inbox')
        const built = await buildTools(ctx)
        try {
            expect(built.tools.request_approval).toBeDefined()
            await writeAgentConfig(scout, agentConfigSchema.parse({ name: scout, tools: { requestApproval: true, desktopToolGrants: { requestApproval: false } } }))
            const execute = built.tools.request_approval!.execute as (input: unknown, options: unknown) => Promise<unknown>
            await expect(execute({ approvals: [{ action: 'Send the report' }] }, options('approval-1'))).rejects.toThrow('This tool is turned off for this coworker.')
            expect((await recorded())[0]).toMatchObject({ tool: 'request_approval', outcome: 'refused-no-permission', rule: 'permission:requestApproval', source: 'trigger', sourceSlug: 'inbox', sessionId: 'session-9', runId: 'run-9' })
        } finally { await built.close() }
    }, 60_000)
})

describe('what is kept of a call', () => {
    it('redacts credentials, keeps no message body or file content, and never exceeds 200 characters', async () => {
        const ctx = await context()
        const tools: ToolSet = { http_request: tool({ inputSchema: any, execute: async () => 'ok' }) }
        await run(ctx, tools, 'http_request', {
            url: 'https://user:hunter2@example.test/path', header: 'Authorization: Bearer abcdefghijklmnop', api_key: 'sk-abcdefghijklmnopqrstuv', note: 'n'.repeat(900),
            query: `find ${'q'.repeat(120)}`, a: 'sk-abcdefghijklmnopqrstuv', b: 'b'.repeat(70), c: 'c'.repeat(70), d: 'd'.repeat(70), e: 'e'.repeat(70),
        })
        const summary = (await recorded())[0]!.summary!
        expect(summary.length).toBeLessThanOrEqual(200)
        expect(summary).toContain('url: https://[redacted]@example.test/path')
        expect(summary).toContain('note: [900 characters]')
        for (const secret of ['hunter2', 'abcdefghijklmnop', 'sk-abcdefghijklmnopqrstuv', 'api_key', 'nnnn']) expect(summary).not.toContain(secret)
    })

    it('stores no input at all for tools whose inputs are credentials', async () => {
        const ctx = await context()
        const execute = async () => 'ok'
        const tools: ToolSet = {
            request_secret: tool({ inputSchema: any, execute }), okta_reset_password: tool({ inputSchema: any, execute }), vault_use_login: tool({ inputSchema: any, execute }),
        }
        for (const name of Object.keys(tools)) await run(ctx, tools, name, { name: 'GitHub token', value: 'ghp_abcdefghijklmnopqrstuv', hint: 'visible words' }, name === 'okta_reset_password')
        const records = await recorded()
        expect(records).toHaveLength(3)
        for (const record of records) expect(record.summary).toBeNull()
        expect(records.find(record => record.tool === 'okta_reset_password')).toMatchObject({ kind: 'credential' })
    })
})

describe('never slows or breaks a run', () => {
    it('a trail that cannot be written does not fail the tool, and the lost records are counted', async () => {
        const ctx = await context()
        const added: number[] = []
        let failing = true
        bindDesktopActivitySink(async () => ({
            append: async rows => { if (failing) throw new Error('disk full'); await store.append(rows) },
            addDropped: async count => { added.push(count); await store.addDropped(count) },
        }))
        const tools: ToolSet = { fs_read: tool({ inputSchema: any, execute: async () => 'text' }) }
        expect(await run(ctx, tools, 'fs_read', { path: 'a.md' })).toEqual({ result: 'text' })
        expect(await run(ctx, tools, 'fs_read', { path: 'b.md' })).toEqual({ result: 'text' })
        await settleDesktopActivity()
        expect(recorder.desktopActivityDroppedUnsaved()).toBe(2)
        failing = false
        expect(await run(ctx, tools, 'fs_read', { path: 'c.md' })).toEqual({ result: 'text' })
        await settleDesktopActivity()
        expect(added).toEqual([2])
        expect(await store.dropped()).toBe(2)
        expect(recorder.desktopActivityDroppedUnsaved()).toBe(0)
        expect((await store.list({})).records).toHaveLength(1)
    })

    it('a sink that cannot even be opened, and a note outside any call, are harmless', async () => {
        const ctx = await context()
        bindDesktopActivitySink(async () => { throw new Error('no database') })
        expect(() => noteDesktopActivity({ outcome: 'failed' })).not.toThrow()
        const tools: ToolSet = { fs_read: tool({ inputSchema: any, execute: async () => 'text' }) }
        expect(await run(ctx, tools, 'fs_read', {})).toEqual({ result: 'text' })
        await settleDesktopActivity()
        expect(recorder.desktopActivityDroppedThisLaunch()).toBe(1)
    })

    it('everything recorded in one tick is written together', async () => {
        const ctx = await context()
        const batches: number[] = []
        bindDesktopActivitySink(async () => ({ append: async rows => { batches.push(rows.length); await store.append(rows) }, addDropped: store.addDropped }))
        const tools: ToolSet = { fs_read: tool({ inputSchema: any, execute: () => 'text' }) }
        recordDesktopActivityTools(ctx, tools)
        const execute = tools.fs_read!.execute as (input: unknown, options: unknown) => unknown
        for (let index = 0; index < 5; index++) execute({ path: `${index}.md` }, options(`c${index}`))
        await settleDesktopActivity()
        expect(batches).toEqual([5])
    })

    it('keeps the identity of the tools it records, and does not stack when a run is rebuilt', async () => {
        const ctx = await context()
        const original = tool({ inputSchema: any, execute: async () => 'text' })
        const tools: ToolSet = { fs_read: original }
        expect(recordDesktopActivityTools(ctx, tools).fs_read).toBe(original)
        await run(ctx, tools, 'fs_read', {})
        expect(await recorded()).toHaveLength(1)
    })
})

describe('bounded and private', () => {
    it('prunes rows older than 90 days, in small batches, on write', async () => {
        const now = new Date('2026-11-16T12:00:00.000Z')
        const old = new Date(now.getTime() - 91 * 86_400_000).toISOString(), recent = new Date(now.getTime() - 89 * 86_400_000).toISOString()
        await store.append([row({ at: recent, tool: 'kept' })], new Date(recent))
        await client.execute('BEGIN')
        for (let index = 0; index < ACTIVITY_PRUNE_BATCH + 20; index++) await client.execute({
            sql: "INSERT INTO desktop_activity(id,at,agent_id,source,tool,outcome) VALUES(?,?,?,'chat','old','completed')", args: [`old-${index}`, old, scout],
        })
        await client.execute('COMMIT')
        await store.append([row({ at: now.toISOString(), tool: 'new' })], now)
        expect((await store.list({ search: 'old' })).total).toBe(20)
        await store.append([row({ at: now.toISOString(), tool: 'new' })], now)
        expect((await store.list({ search: 'old' })).total).toBe(0)
        expect((await store.list({})).records.map(record => record.tool)).toEqual(['new', 'new', 'kept'])
    })

    it('keeps at most 50,000 records, dropping the oldest', async () => {
        await store.append([row({ tool: 'first' })])
        await client.execute(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${DESKTOP_ACTIVITY_MAX_RECORDS + 9})
            INSERT INTO desktop_activity(id,at,agent_id,source,tool,outcome) SELECT 'bulk-'||i, '${new Date().toISOString()}', '${scout}', 'chat', 'bulk', 'completed' FROM n`)
        await store.append([row({ tool: 'last' })])
        const page = await store.list({}, { limit: 1 })
        expect(page.total).toBe(DESKTOP_ACTIVITY_MAX_RECORDS)
        expect(page.records[0]!.tool).toBe('last')
        expect((await store.list({ search: 'first' })).total).toBe(0)
    })

    it('a deleted coworker’s records stay: the trail is the workspace’s, not the coworker’s', async () => {
        const ctx = await context()
        await run(ctx, { fs_read: tool({ inputSchema: any, execute: async () => 'text' }) }, 'fs_read', {})
        await settleDesktopActivity()
        await rm(agentDir(scout), { recursive: true, force: true })
        expect((await store.list({ agentIds: [scout] })).records).toHaveLength(1)
        await mkdir(agentDir(scout), { recursive: true })
    })
})

describe('filters, search and the routes the app reads', () => {
    beforeEach(async () => {
        await store.append([
            row({ id: 'a', at: '2026-11-10T10:00:00.000Z', agentId: 'scout', tool: 'GMAIL_SEND_EMAIL', app: 'Gmail', kind: 'send', outcome: 'allowed-once-by-person', rule: 'ask-first:send' }),
            row({ id: 'b', at: '2026-11-11T10:00:00.000Z', agentId: 'ledger', tool: 'shared_edit', outcome: 'refused-no-permission', rule: 'permission:sharedFilesWrite', source: 'routine', sourceSlug: 'books' }),
            row({ id: 'c', at: '2026-11-12T10:00:00.000Z', agentId: 'gone', tool: 'fs_read', outcome: 'allowed-by-permission', rule: 'permission:workspaceRead' }),
            row({ id: 'd', at: '2026-11-13T10:00:00.000Z', agentId: 'scout', tool: 'drive_delete_file', app: 'Drive', kind: 'delete', outcome: 'declined-by-person', rule: 'ask-first:delete', source: 'trigger', sourceSlug: 'inbox' }),
            row({ id: 'e', at: '2026-11-14T10:00:00.000Z', agentId: 'scout', tool: '100%_done', outcome: 'failed' }),
        ], new Date('2026-11-16T00:00:00.000Z'))
    })
    const ids = async (filters: Parameters<typeof store.list>[0]) => (await store.list(filters)).records.map(record => record.id)

    it('filters by coworker, outcome, risky kind, source and date range, newest first', async () => {
        expect(await ids({})).toEqual(['e', 'd', 'c', 'b', 'a'])
        expect(await ids({ agentIds: ['scout'] })).toEqual(['e', 'd', 'a'])
        expect(await ids({ excludeAgentIds: ['scout', 'ledger'] })).toEqual(['c'])
        expect(await ids({ agentIds: [] })).toEqual([])
        expect(await ids({ outcomes: ['declined-by-person', 'refused-no-permission'] })).toEqual(['d', 'b'])
        expect(await ids({ risky: true })).toEqual(['d', 'a'])
        expect(await ids({ sources: ['routine', 'trigger'] })).toEqual(['d', 'b'])
        expect(await ids({ from: '2026-11-11T00:00:00.000Z', to: '2026-11-13T23:59:59.999Z' })).toEqual(['d', 'c', 'b'])
        expect(await ids({ agentIds: ['scout'], risky: true, outcomes: ['allowed-once-by-person'] })).toEqual(['a'])
    })

    it('searches tool and app names, treating % and _ as text', async () => {
        expect(await ids({ search: 'gmail' })).toEqual(['a'])
        expect(await ids({ search: 'Drive' })).toEqual(['d'])
        expect(await ids({ search: 'shared edit' })).toEqual(['b'])
        expect(await ids({ search: '100%' })).toEqual(['e'])
        expect(await ids({ search: '%' })).toEqual(['e'])
        expect(await ids({ search: "'; DROP TABLE desktop_activity; --" })).toEqual([])
        expect(await ids({})).toHaveLength(5)
    })

    it('pages newest first without repeating a row', async () => {
        const first = await store.list({}, { limit: 2 })
        expect(first.records.map(record => record.id)).toEqual(['e', 'd'])
        expect(first.total).toBe(5)
        const second = await store.list({}, { limit: 2, before: first.next })
        expect(second.records.map(record => record.id)).toEqual(['c', 'b'])
        const third = await store.list({}, { limit: 2, before: second.next })
        expect(third.records.map(record => record.id)).toEqual(['a'])
        expect(third.next).toBeNull()
    })

    it('reads a query string, ignoring what it does not know', () => {
        expect(desktopActivityFiltersOf({ agents: 'scout, ledger', outcomes: 'failed,nonsense', sources: 'routine', risky: '1', from: '2026-11-11', to: 'not a date', q: '  mail ' })).toEqual({
            agentIds: ['scout', 'ledger'], outcomes: ['failed'], sources: ['routine'], risky: true, from: '2026-11-11T00:00:00.000Z', search: 'mail',
        })
        expect(desktopActivityFiltersOf({ agents: '' })).toEqual({ agentIds: [] })
        expect(desktopActivityFiltersOf({})).toEqual({})
    })

    it('the route lists with filters and the dropped count, and clearing empties the trail', async () => {
        const app = createDesktopActivityRouter(async () => store)
        await store.addDropped(3)
        const listed = desktopActivityPageSchema.parse(await (await app.request('/?agents=scout&risky=1&limit=1')).json())
        expect(listed).toMatchObject({ total: 2, dropped: 3 })
        expect(listed.records.map(record => record.id)).toEqual(['d'])
        const older = desktopActivityPageSchema.parse(await (await app.request(`/?agents=scout&risky=1&limit=1&before=${listed.next}`)).json())
        expect(older.records.map(record => record.id)).toEqual(['a'])
        expect((await app.request('/', { method: 'DELETE' })).status).toBe(200)
        expect(desktopActivityPageSchema.parse(await (await app.request('/')).json())).toEqual({ records: [], next: null, total: 0, dropped: 0 })
    })
})
