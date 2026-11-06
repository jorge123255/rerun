import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SelfMcpProposal, SelfMcpServerInput } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '../store'
import type { DesktopRuntime } from '../runtime'
import { remoteMcpStore } from '../mcp/store'
import { createDesktopSelfMcpBinding } from './binding'
import { desktopSelfMcpSchema } from './schema'
import { selfMcpFingerprint } from './fingerprint'

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), generation: 0 }))
vi.mock('../runtime', async original => ({ ...await original<typeof import('../runtime')>(), readDesktopRuntime: mocks.runtime }))
vi.mock('../mcp-binding', () => ({ getDesktopRemoteMcpService: vi.fn(), watchDesktopMcpOwner: () => {
    const version = mocks.generation
    return () => { if (version !== mocks.generation) throw new Error('Coworker permission changed') }
} }))
let directory: string, runtime: DesktopRuntime, db: Awaited<ReturnType<typeof openDesktopDatabase>>, agent: DesktopAgent, session: DesktopSession
let status: 'running' | 'done' | 'cancelled', granted: boolean, sourceAcknowledged: boolean
let source: SelfMcpProposal | null
const input: SelfMcpServerInput = { name: 'arithmetic', command: '/usr/local/bin/arithmetic-mcp', args: [], transport: 'stdio', env: {}, headers: {} }
const shutdown = () => new AbortController().signal
const identity = () => ({ engineAgentId: agent.engineAgentId, sessionId: session.engineSessionId, runId: 'source-run', toolCallId: 'call-exact-source' })
function proof() {
    const call = identity(), result = `Proposed MCP server "${input.name}" (stdio). A review card is waiting in the Mac app — nothing is saved, connected or executed until a human approves it there.`
    return {
        tools: [{ ...call, agentId: call.engineAgentId, toolName: 'mcp_register', inputJson: JSON.stringify(source?.input ?? input), resultJson: JSON.stringify(result), isError: 0 }],
        messages: [
            { id: 'assistant-source', sessionId: call.sessionId, role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolCallId: call.toolCallId, toolName: 'mcp_register', input: source?.input ?? input }]) },
            { id: 'tool-result', sessionId: call.sessionId, role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: call.toolCallId, toolName: 'mcp_register', output: { type: 'text', value: result } }]) },
        ],
    }
}
const network = vi.fn()
async function service() {
    return createDesktopSelfMcpBinding(runtime, {
        db, shutdownSignal: shutdown(), remoteStore: remoteMcpStore(db, () => Buffer.alloc(32, 7)),
        managedNames: async () => [], mutate: async (_owner, _name, write) => write(),
        owner: async (local, engine) => {
            const rows = (await db.execute({ sql: `SELECT id,engine_agent_id FROM desktop_agents WHERE workspace_id=1 AND ${local ? 'id' : 'engine_agent_id'}=?`, args: [local ?? engine!] })).rows
            if (rows.length !== 1) throw new Error('Coworker not found')
            return { id: String(rows[0].id), engineId: String(rows[0].engine_agent_id) }
        },
        engineJson: async path => {
            if (path.endsWith('/tools')) return { tools: sourceAcknowledged ? proof().tools : [] }
            if (path.endsWith('/messages')) return { messages: sourceAcknowledged ? proof().messages : [] }
            if (path.includes('/runs/')) return { id: 'source-run', agentId: agent.engineAgentId, sessionId: session.engineSessionId, status }
            if (path.includes('/sessions/')) return { id: session.engineSessionId, agentId: agent.engineAgentId }
            return { id: agent.engineAgentId, config: { enabled: true, selfImprovement: { enabled: true }, tools: { desktopToolGrants: { selfMcpRegister: granted, mcp: true, localMcpStdio: true } } } }
        },
    })
}
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-self-mcp-binding-'))
    runtime = { protocolVersion: 1, launchNonce: 'first-launch', buildId: 'test', workspaceId: 1, dataRoot: directory, app: { origin: 'http://127.0.0.1:3100', sessionToken: 'a'.repeat(48) }, engine: { origin: 'http://127.0.0.1:3200', apiKey: 'fixture' } }
    mocks.runtime.mockImplementation(async () => runtime); mocks.generation = 0
    db = await openDesktopDatabase(directory); await db.executeMultiple(desktopSelfMcpSchema)
    agent = await createDesktopAgent(db, { name: 'MCP review fixture', engineAgentId: 'engine-owner' })
    session = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-chat', title: 'Review fixture' })
    status = 'running'; granted = true; sourceAcknowledged = false; source = null
    network.mockClear(); vi.stubGlobal('fetch', network)
})
afterEach(async () => { await closeDesktopDatabase(directory); await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals() })
async function propose() {
    const bound = await service(), result = await bound.propose({ identity: identity(), input, fingerprint: selfMcpFingerprint(input) })
    if (!('proposal' in result) || !result.proposal) throw new Error('Fixture proposal was refused')
    source = result.proposal
    return { bound, proposal: result.proposal }
}
const decision = (proposal: SelfMcpProposal, revision: number) => ({ proposalId: proposal.id, decisionId: 'one-human-decision', expectedProposalRevision: proposal.revision, expectedConfigRevision: revision, outcome: { kind: 'approved' as const } })

test('an acknowledged completed proposal survives restart and saves only after human approval without spawning or networking', async () => {
    const { proposal } = await propose()
    expect((await db.execute('SELECT * FROM desktop_mcp_stdio')).rows).toEqual([])
    expect(network).not.toHaveBeenCalled()
    status = 'done'; sourceAcknowledged = true
    await closeDesktopDatabase(directory); runtime = { ...runtime, launchNonce: 'second-launch' }; db = await openDesktopDatabase(directory)
    const bound = await service(), review = await bound.review(agent.id, proposal.id)
    expect(review.requirements).toEqual([])
    expect(review.proposal.launchEpoch).toBe('first-launch')
    const result = await bound.decide(agent.id, decision(proposal, review.configRevision))
    expect(result.outcome).toBe('applied_unverified')
    expect((await db.execute('SELECT name,executable FROM desktop_mcp_stdio')).rows).toMatchObject([{ name: input.name, executable: input.command }])
    expect(network).not.toHaveBeenCalled()
    const replay = await bound.decide(agent.id, decision(proposal, review.configRevision))
    expect(replay.receipt).toEqual(result.receipt)
    expect((await db.execute('SELECT * FROM desktop_self_mcp_effects')).rows).toHaveLength(1)
})

test.each(['stopped', 'unacknowledged', 'revoked', 'remapped', 'unfinished-restart'] as const)('a %s source cannot publish a connection', async kind => {
    const { proposal } = await propose()
    status = 'done'; sourceAcknowledged = true
    if (kind === 'stopped') status = 'cancelled'
    if (kind === 'unacknowledged') sourceAcknowledged = false
    if (kind === 'revoked') granted = false
    if (kind === 'remapped') await db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id=? WHERE id=?', args: ['replacement-engine', agent.id] })
    if (kind === 'unfinished-restart') { status = 'running'; runtime = { ...runtime, launchNonce: 'second-launch' } }
    const bound = await service(), review = await bound.review(agent.id, proposal.id)
    expect(review.requirements.length).toBeGreaterThan(0)
    expect((await bound.decide(agent.id, decision(proposal, review.configRevision))).outcome).not.toMatch(/^applied/)
    expect((await db.execute('SELECT * FROM desktop_mcp_stdio')).rows).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_self_mcp_effects')).rows).toEqual([])
    expect(network).not.toHaveBeenCalled()
})

test('a reference-based proposal remains intact and pending instead of silently dropping its environment', async () => {
    const bound = await service(), candidate = { ...input, env: { TOKEN: '${EXAMPLE_API_KEY}' } }
    const result = await bound.propose({ identity: identity(), input: candidate, fingerprint: selfMcpFingerprint(candidate) })
    if (!('proposal' in result) || !result.proposal) throw new Error('Proposal missing')
    source = result.proposal; status = 'done'; sourceAcknowledged = true
    const review = await bound.review(agent.id, result.proposal.id)
    expect(review.proposal.input.env).toEqual(candidate.env)
    expect(review.requirements.join(' ')).toContain('credential references')
    expect((await bound.decide(agent.id, decision(result.proposal, review.configRevision))).outcome).toBe('failed')
    expect((await bound.list(agent.id))[0].status).toBe('pending')
    expect((await db.execute('SELECT * FROM desktop_mcp_stdio')).rows).toEqual([])
})
