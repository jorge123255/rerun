import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { SelfMcpDecision, SelfMcpReceipt } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent } from '../store'
import { createSelfMcpSqlStore } from './sql-store'
import { desktopSelfMcpSchema } from './schema'
import type { SelfMcpNewProposal } from './store'
import { selfMcpFingerprint } from './fingerprint'
let directory: string, db: Awaited<ReturnType<typeof openDesktopDatabase>>, proposal: SelfMcpNewProposal
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-self-mcp-store-')); db = await openDesktopDatabase(directory)
    await db.executeMultiple(desktopSelfMcpSchema)
    const agent = await createDesktopAgent(db, { name: 'Review fixture', engineAgentId: 'engine-owner' })
    const input = { name: 'server', transport: 'http' as const, url: 'https://example.com/mcp', args: [], env: {}, headers: {} }
    proposal = { id: 'proposal', agentId: agent.id, identity: { engineAgentId: agent.engineAgentId, sessionId: 'source-chat', runId: 'source-run', toolCallId: 'source-call' }, launchEpoch: 'original-launch', fingerprint: selfMcpFingerprint(input), input, transport: 'http', configRevision: 0, createdAt: '2026-11-05T00:00:00Z' }
})
afterEach(async () => { await closeDesktopDatabase(directory); await rm(directory, { recursive: true, force: true }) })
const decision = (): SelfMcpDecision => ({ id: 'human-decision', agentId: proposal.agentId, proposalId: proposal.id, proposalRevision: 1, configRevision: 0, identity: proposal.identity, fingerprint: proposal.fingerprint, outcome: { kind: 'approved' }, decidedAt: proposal.createdAt })

test('same invocation retains one proposal across restart and refuses a changed candidate', async () => {
    expect((await createSelfMcpSqlStore(db).reserve(proposal)).outcome).toBe('created')
    await closeDesktopDatabase(directory); db = await openDesktopDatabase(directory)
    const store = createSelfMcpSqlStore(db)
    const replay = await store.reserve({ ...proposal, id: 'different-transport-attempt', launchEpoch: 'new-launch' })
    expect(replay.outcome).toBe('reconciled')
    expect(await store.reserve({ ...proposal, fingerprint: 'a'.repeat(64) })).toEqual({ outcome: 'conflict' })
    expect(await store.list(proposal.agentId)).toHaveLength(1)
})

test('competing decisions claim once and a receipt settles only that immutable decision after restart', async () => {
    const store = createSelfMcpSqlStore(db); await store.reserve(proposal)
    const first = await store.claim(proposal.agentId, proposal.id, 1, decision())
    expect(first.result).toBe('transitioned')
    expect((await store.claim(proposal.agentId, proposal.id, 1, { ...decision(), id: 'second-tab' })).result).toBe('stale')
    if (first.result !== 'transitioned') throw new Error('Fixture claim failed')
    await closeDesktopDatabase(directory); db = await openDesktopDatabase(directory)
    const restarted = createSelfMcpSqlStore(db)
    const receipt: SelfMcpReceipt = { id: 'receipt', proposalId: proposal.id, decisionId: decision().id, outcome: 'applied_unverified', configRevision: 1, createdAt: proposal.createdAt }
    expect((await restarted.settle(proposal.agentId, first.proposal, 'applied', { ...receipt, decisionId: 'forged-decision' })).result).toBe('conflict')
    expect((await restarted.settle(proposal.agentId, first.proposal, 'applied', receipt)).result).toBe('transitioned')
    expect(await restarted.receipts.byDecision(proposal.agentId, decision().id)).toEqual(receipt)
    expect((await restarted.get(proposal.agentId, proposal.id))?.status).toBe('applied')
})

test('the final synchronous source fence prevents a cancelled reservation from becoming durable', async () => {
    let checks = 0
    await expect(createSelfMcpSqlStore(db).reserve(proposal, () => { if (++checks > 1) throw new Error('Stopped') })).rejects.toThrow('Stopped')
    expect(await createSelfMcpSqlStore(db).list(proposal.agentId)).toEqual([])
})
