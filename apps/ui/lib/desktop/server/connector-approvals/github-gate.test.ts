import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopActivityDecisionSchema, desktopActivitySentence, desktopConnectorCall, DESKTOP_GITHUB_WRITE_OFF_MESSAGE, type DesktopActivityDecision } from '@rerun/contracts'

const mocks = vi.hoisted(() => ({ tools: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('../mcp/tools', () => ({ remoteMcpTools: mocks.tools }))
const { desktopMcpBridge, desktopMcpBridgeRequest } = await import('../mcp/bridge')
const { remoteMcpLifecycle } = await import('../mcp/lifecycle')
const { initializeDesktopRound61 } = await import('../round61-schema')
const { decideConnectorApproval, decideConnectorCall, readConnectorApprovals } = await import('./store')
const { admitGithubCall } = await import('./github-gate')

let db: Client, dir: string
let granted = false
beforeEach(async () => {
    granted = false
    dir = await mkdtemp(join(tmpdir(), 'github-gate-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound61(db)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

// The admission exactly as mcp-binding.ts composes it: the GitHub check first, then the ordinary ask-first one.
const reached: { tool: string; args: unknown }[] = []
const trails: DesktopActivityDecision[] = []
function bridge() {
    const result = (text: string) => ({ source: 'remote_mcp', untrusted: true, result: { content: [{ type: 'text', text }] } })
    const tool = (name: string, server?: { host?: string; name?: string; tool?: string }) => ({ name, description: name, inputSchema: { type: 'object' }, ...(server && { server }), execute: async (args: unknown) => { reached.push({ tool: name, args }); return result(`ran ${name}`) } })
    mocks.tools.mockResolvedValue([
        tool('github_get_file_contents'), tool('github_create_pull_request'), tool('github_merge_pull_request'), tool('github_delete_file'), tool('github_add_issue_comment'),
        tool('gh_create_branch', { host: 'api.githubcopilot.com', name: 'gh', tool: 'create_branch' }),
        tool('COMPOSIO_MULTI_EXECUTE_TOOL'), tool('mail_send_email'), tool('drive_list_files'),
    ])
    return desktopMcpBridge({ lifecycle: remoteMcpLifecycle() } as never, {} as never, async () => 'coworker-1', undefined, async (call, _signal, note) => {
        const github = await admitGithubCall(call, { granted: async () => granted, decide: held => decideConnectorCall(db, held) })
        if (github.handled) { note?.(github.trail); return github.answer }
        const held = desktopConnectorCall(call.tool, call.destructive, call.arguments)
        if (!held) return null
        const decided = await decideConnectorCall(db, { owner: call.owner, sessionId: call.sessionId, tool: held.tool, kind: held.kind, arguments: held.subject ?? call.arguments })
        note?.(decided.trail)
        return decided.answer
    })
}
let calls = 0
async function run(tool: string, args: Record<string, unknown> = {}, sessionId = 'chat-1') {
    const active = bridge()
    const handle = (body: unknown) => active.handle(desktopMcpBridgeRequest.parse(body), new AbortController().signal) as Promise<{ trail?: DesktopActivityDecision; result: { result: { isError?: boolean; content: { text: string }[] } } }>
    const identity = { engineAgentId: 'engine-1', sessionId, runId: `run-${++calls}` }
    const catalog = await handle({ action: 'catalog', ...identity }) as unknown as { catalogId: string; tools: { capabilityId: string; name: string }[] }
    const answer = await handle({ action: 'call', ...identity, catalogId: catalog.catalogId, capabilityId: catalog.tools.find(row => row.name === tool)!.capabilityId, toolCallId: `call-${calls}`, arguments: args })
    await handle({ action: 'release', ...identity, catalogId: catalog.catalogId })
    if (answer.trail) trails.push(desktopActivityDecisionSchema.parse(answer.trail))
    return { text: answer.result.result.content[0]!.text, isError: answer.result.result.isError === true, trail: answer.trail }
}
beforeEach(() => { reached.length = 0; trails.length = 0; calls = 0 })
const pending = async (sessionId = 'chat-1') => (await readConnectorApprovals(db, sessionId)).pending
const pr = { owner: 'acme', repo: 'openflix', title: 'Fix the guide', head: 'fix', base: 'main' }

test('with the permission off, a change is refused before it runs and reads still work', async () => {
    expect((await run('github_get_file_contents', { path: 'README.md' })).text).toBe('ran github_get_file_contents')
    const refused = await run('github_create_pull_request', pr)
    expect(refused).toMatchObject({ isError: true, text: DESKTOP_GITHUB_WRITE_OFF_MESSAGE })
    expect(refused.text).toContain('Change GitHub repositories')
    // Nothing reached GitHub, and no card was made: there is nothing to allow while the permission is off.
    expect(reached.map(call => call.tool)).toEqual(['github_get_file_contents'])
    expect(await pending()).toEqual([])
    // The activity trail gets the refusal and the permission that decided it.
    expect(refused.trail).toEqual({ outcome: 'refused-no-permission', rule: 'permission:githubWrite', kind: 'repository', app: 'GitHub', action: 'github_create_pull_request' })
    expect(desktopActivitySentence('Scout', { tool: 'github_create_pull_request', action: null, app: 'GitHub', kind: 'repository', outcome: 'refused-no-permission', rule: 'permission:githubWrite' }))
        .toBe('Scout was refused: Change GitHub repositories is off')
    for (const tool of ['github_merge_pull_request', 'github_delete_file', 'github_add_issue_comment', 'gh_create_branch']) expect((await run(tool, { n: 1 })).text, tool).toBe(DESKTOP_GITHUB_WRITE_OFF_MESSAGE)
    expect(reached).toHaveLength(1)
})

test('an earlier "always allow" does not stand in for the permission', async () => {
    granted = true
    await run('github_create_pull_request', pr)
    await decideConnectorApproval(db, 'chat-1', (await pending())[0]!.id, 'always')
    expect((await run('github_create_pull_request', pr)).text).toBe('ran github_create_pull_request')
    // The owner turns the permission off again: the standing answer no longer lets the change through.
    granted = false
    expect((await run('github_create_pull_request', pr)).text).toBe(DESKTOP_GITHUB_WRITE_OFF_MESSAGE)
    expect(reached).toHaveLength(1)
})

test('a permission that cannot be read is an off permission', async () => {
    const answer = await admitGithubCall({ owner: 'coworker-1', sessionId: 'chat-1', tool: 'github_push_files', arguments: {} },
        { granted: async () => { throw new Error('engine unreachable') }, decide: async () => { throw new Error('must not ask') } })
    expect(answer).toMatchObject({ handled: true, answer: DESKTOP_GITHUB_WRITE_OFF_MESSAGE })
})

test('Chief can read through a shared GitHub connection but cannot borrow a coworker grant for direct or wrapped writes', async () => {
    const owner = { owner: 'foreman', sessionId: 'chief-chat' }
    const ports = { granted: vi.fn(async () => true), decide: vi.fn(async (call: Parameters<typeof decideConnectorCall>[1]) => decideConnectorCall(db, call)) }
    const wrapper = (slugs: string[]) => ({
        ...owner, tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: slugs.map(tool_slug => ({ tool_slug, arguments: {} })) },
    })
    expect(await admitGithubCall(wrapper(['GITHUB_GET_A_PULL_REQUEST']), ports)).toEqual({ handled: false })
    for (const call of [
        { ...owner, tool: 'github_pull_request_review_write', arguments: {} },
        wrapper(['GITHUB_GET_A_PULL_REQUEST', 'GITHUB_REQUEST_REVIEWERS_FOR_A_PULL_REQUEST']),
    ]) {
        const decision = await admitGithubCall(call, ports)
        expect(decision).toMatchObject({
            handled: true, answer: expect.stringContaining('Chief of Staff has read-only GitHub access'),
            trail: { outcome: 'refused-no-permission', rule: 'permission:githubWrite' },
        })
    }
    expect(ports.granted).not.toHaveBeenCalled()
    expect(ports.decide).not.toHaveBeenCalled()
})

test('with the permission on, a change asks first and runs only after the person allows it', async () => {
    granted = true
    const held = await run('github_create_pull_request', pr)
    expect(held.isError).toBe(true)
    expect(held.text).toMatch(/changes a GitHub repository\. This call did not run/)
    expect(held.trail).toMatchObject({ outcome: 'asked-person', rule: 'ask-first:repository', kind: 'repository', app: 'GitHub' })
    expect(reached).toEqual([])
    const [card] = await pending()
    expect(card).toMatchObject({ tool: 'github_create_pull_request', kind: 'repository' })
    await decideConnectorApproval(db, 'chat-1', card!.id, 'once')
    const ran = await run('github_create_pull_request', pr)
    expect(ran.text).toBe('ran github_create_pull_request')
    expect(ran.trail).toMatchObject({ outcome: 'allowed-once-by-person' })
    // Once is once, and other arguments were never allowed.
    expect((await run('github_create_pull_request', pr)).isError).toBe(true)
    expect(reached).toHaveLength(1)
    // Declining is told to the coworker and nothing runs.
    const comment = { issue_number: 4, body: 'Looks good' }
    await run('github_add_issue_comment', comment)
    await decideConnectorApproval(db, 'chat-1', (await pending()).find(row => row.tool === 'github_add_issue_comment')!.id, 'deny')
    expect((await run('github_add_issue_comment', comment)).trail).toMatchObject({ outcome: 'declined-by-person' })
    expect(reached).toHaveLength(1)
    // Reads never ask.
    expect((await run('github_get_file_contents', {})).isError).toBe(false)
})

test('an ordinary change may get a standing answer; merging and deleting a branch or a file ask every time', async () => {
    granted = true
    await run('github_create_pull_request', pr)
    expect(await decideConnectorApproval(db, 'chat-1', (await pending())[0]!.id, 'always')).toMatchObject({ decision: 'always' })
    expect((await run('github_create_pull_request', { ...pr, title: 'Another' }, 'chat-2')).trail).toMatchObject({ outcome: 'allowed-by-permission', rule: 'standing-answer:always' })

    for (const tool of ['github_merge_pull_request', 'github_delete_file']) {
        const args = { owner: 'acme', repo: 'openflix', target: tool }
        expect((await run(tool, args)).text, tool).toMatch(/did not run/)
        const card = (await pending()).find(row => row.tool === tool)!
        // No standing answer can be saved for it.
        expect(await decideConnectorApproval(db, 'chat-1', card.id, 'always'), tool).toBeNull()
        expect(await decideConnectorApproval(db, 'chat-1', card.id, 'conversation'), tool).toBeNull()
        expect(await decideConnectorApproval(db, 'chat-1', card.id, 'once'), tool).toMatchObject({ decision: 'once' })
        expect((await run(tool, args)).text, tool).toBe(`ran ${tool}`)
        // The next one asks again, even for the very same arguments.
        expect((await run(tool, args)).text, tool).toMatch(/did not run/)
    }
    // A standing answer saved by any other route is ignored for these.
    await db.execute({ sql: "INSERT INTO desktop_connector_approval_rules(id,owner,tool,session_id,created_at) VALUES('00000000-0000-4000-8000-000000000001','coworker-1','github_merge_pull_request','','2026-11-16T12:00:00.000Z')" })
    expect((await run('github_merge_pull_request', { pull_number: 9 })).text).toMatch(/did not run/)
    expect(reached.filter(call => call.tool === 'github_merge_pull_request')).toHaveLength(1)
})

test('a GitHub connector under another name is recognised by its host', async () => {
    expect((await run('gh_create_branch', { branch: 'fix' })).text).toBe(DESKTOP_GITHUB_WRITE_OFF_MESSAGE)
    granted = true
    await run('gh_create_branch', { branch: 'fix' })
    expect((await pending())[0]).toMatchObject({ tool: 'github_create_branch', kind: 'repository' })
})

test('GitHub through Composio multi-execute: each inner tool is classified', async () => {
    const multi = (...slugs: string[]) => ({ tools: slugs.map(tool_slug => ({ tool_slug, arguments: { owner: 'acme', repo: 'openflix' } })), thought: `attempt ${Math.random()}` })
    // Only reads inside: runs at once.
    expect((await run('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_LIST_COMMITS', 'GITHUB_GET_A_PULL_REQUEST'))).isError).toBe(false)
    // A change inside, permission off: the whole call is refused, the reads beside it included.
    const refused = await run('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_LIST_COMMITS', 'GITHUB_CREATE_A_PULL_REQUEST'))
    expect(refused.text).toBe(DESKTOP_GITHUB_WRITE_OFF_MESSAGE)
    expect(refused.trail).toMatchObject({ outcome: 'refused-no-permission', rule: 'permission:githubWrite', action: 'GITHUB_CREATE_A_PULL_REQUEST' })
    expect(reached).toHaveLength(1)
    // Permission on: held under the inner tool's name; the wrapper's changing notes do not make it a new request.
    granted = true
    await run('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_CREATE_A_PULL_REQUEST'))
    const [card] = await pending()
    expect(card).toMatchObject({ tool: 'GITHUB_CREATE_A_PULL_REQUEST', kind: 'repository' })
    await decideConnectorApproval(db, 'chat-1', card!.id, 'once')
    expect((await run('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_CREATE_A_PULL_REQUEST'))).isError).toBe(false)
    // An inner merge asks every time and takes no standing answer.
    await run('COMPOSIO_MULTI_EXECUTE_TOOL', multi('GITHUB_MERGE_A_PULL_REQUEST'))
    const merge = (await pending()).find(row => row.tool === 'GITHUB_MERGE_A_PULL_REQUEST')!
    expect(await decideConnectorApproval(db, 'chat-1', merge.id, 'always')).toBeNull()
})

test('other connectors go on to the ordinary ask-first check untouched', async () => {
    expect((await run('drive_list_files')).isError).toBe(false)
    const held = await run('mail_send_email', { to: 'pat@example.test' })
    expect(held.text).toMatch(/sends something to other people/)
    expect((await pending())[0]).toMatchObject({ tool: 'mail_send_email', kind: 'send' })
})
