import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopConnectorActionKind } from '@rerun/contracts'

const mocks = vi.hoisted(() => ({ tools: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('../mcp/tools', () => ({ remoteMcpTools: mocks.tools }))
const { desktopMcpBridge, desktopMcpBridgeRequest } = await import('../mcp/bridge')
const { remoteMcpLifecycle } = await import('../mcp/lifecycle')
const { initializeDesktopRound61 } = await import('../round61-schema')
const { admitConnectorCall, decideConnectorApproval, readConnectorApprovals } = await import('./store')

let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'connector-flow-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound61(db)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

// The bridge and the store as the app binds them, with a stand-in connector behind them. Each
// reply is its own run with its own catalog, as it is in the app.
test('a held connector call reaches the connector only in a later run, after the person allowed it', async () => {
    const sent: unknown[] = [], listed: unknown[] = []
    const result = (text: string) => ({ source: 'remote_mcp', untrusted: true, result: { content: [{ type: 'text', text }] } })
    mocks.tools.mockResolvedValue([
        { name: 'mail_send_email', description: 'Send an email', inputSchema: { type: 'object' }, execute: async (args: unknown) => { sent.push(args); return result('sent') } },
        { name: 'mail_list_messages', description: 'List mail', inputSchema: { type: 'object' }, execute: async (args: unknown) => { listed.push(args); return result('2 messages') } },
        { name: 'notes_sync', description: 'Sync', inputSchema: { type: 'object' }, destructive: true, execute: async (args: unknown) => { sent.push(args); return result('synced') } },
    ])
    const bridge = desktopMcpBridge({ lifecycle: remoteMcpLifecycle() } as never, {} as never, async () => 'coworker-1', undefined, async call => {
        const kind = desktopConnectorActionKind(call.tool, call.destructive)
        return kind ? admitConnectorCall(db, { owner: call.owner, sessionId: call.sessionId, tool: call.tool, kind, arguments: call.arguments }) : null
    })
    const handle = (body: unknown) => bridge.handle(desktopMcpBridgeRequest.parse(body), new AbortController().signal) as Promise<{ result: { result: { isError?: boolean; content: { text: string }[] } } }>
    let calls = 0
    async function run(runId: string, tool: string, args: Record<string, unknown>, sessionId = 'chat-1') {
        const identity = { engineAgentId: 'engine-1', sessionId, runId }
        const catalog = await handle({ action: 'catalog', ...identity }) as unknown as { catalogId: string; tools: { capabilityId: string; name: string }[] }
        const answer = await handle({ action: 'call', ...identity, catalogId: catalog.catalogId, capabilityId: catalog.tools.find(row => row.name === tool)!.capabilityId, toolCallId: `call-${++calls}`, arguments: args })
        await handle({ action: 'release', ...identity, catalogId: catalog.catalogId })
        return answer.result.result
    }
    const mail = { to: 'pat@example.test', subject: 'Q4 plan' }
    try {
        // An ordinary read runs at once and leaves nothing waiting.
        expect((await run('run-1', 'mail_list_messages', {})).content[0]!.text).toBe('2 messages')
        expect(listed).toHaveLength(1)

        // The send is held: the coworker is told, the connector is not reached, a card is waiting.
        const held = await run('run-1b', 'mail_send_email', mail)
        expect(held.isError).toBe(true)
        expect(held.content[0]!.text).toMatch(/did not run/)
        expect(sent).toEqual([])
        const [card] = (await readConnectorApprovals(db, 'chat-1')).pending
        expect(card).toMatchObject({ tool: 'mail_send_email', kind: 'send' })

        // Calling again before an answer changes nothing.
        expect((await run('run-2', 'mail_send_email', mail)).content[0]!.text).toMatch(/still waiting/)
        expect(sent).toEqual([])

        // Allowed once: the next run's identical call reaches the connector, exactly once.
        await decideConnectorApproval(db, 'chat-1', card!.id, 'once')
        expect((await run('run-3', 'mail_send_email', mail)).content[0]!.text).toBe('sent')
        expect(sent).toEqual([mail])
        expect((await run('run-4', 'mail_send_email', mail)).isError).toBe(true)
        expect((await run('run-5', 'mail_send_email', { ...mail, to: 'someone-else@example.test' })).isError).toBe(true)
        expect(sent).toEqual([mail])

        // A tool its connector marks destructive asks too, whatever it is called; a refusal never runs it.
        expect((await run('run-6', 'notes_sync', {})).content[0]!.text).toMatch(/deletes something/)
        const marked = (await readConnectorApprovals(db, 'chat-1')).pending.find(row => row.tool === 'notes_sync')!
        await decideConnectorApproval(db, 'chat-1', marked.id, 'deny')
        expect((await run('run-7', 'notes_sync', {})).content[0]!.text).toMatch(/declined/)
        expect(sent).toEqual([mail])
    } finally { bridge.shutdown() }
})
