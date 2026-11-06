import { describe, expect, it } from 'vitest'
import type { SelfMcpReceipt } from '@rerun/contracts'
import { createSelfMcpMemoryStore } from './store'
import { decisionFor, identity, NOW, seedProposal } from './test-support'

const receipt = (changes: Partial<SelfMcpReceipt> = {}): SelfMcpReceipt => ({
    id: 'receipt-1', proposalId: 'prop-1', decisionId: 'dec-1', outcome: 'applied', configRevision: 4, createdAt: NOW, ...changes,
})

describe('self-MCP store operation identity', () => {
    it('reserves the exact immutable decision in the same claim and refuses decision-id reuse', async () => {
        const store = createSelfMcpMemoryStore()
        await seedProposal(store)
        const claim = await store.claim('local-1', 'prop-1', 1, decisionFor())
        expect(claim.result).toBe('transitioned')
        expect(await store.decisions.byId('local-1', 'dec-1')).toEqual(decisionFor())
        await seedProposal(store, { id: 'prop-2', identity: identity({ toolCallId: 'call-2' }) })
        expect(await store.claim('local-1', 'prop-2', 1, decisionFor({ proposalId: 'prop-2', identity: identity({ toolCallId: 'call-2' }) }))).toEqual({ result: 'conflict' })
        expect((await store.get('local-1', 'prop-2'))?.status).toBe('pending')
    })

    it('does not overwrite a proposal when a generated id collides with another invocation', async () => {
        const store = createSelfMcpMemoryStore()
        await seedProposal(store)
        expect(await seedProposal(store, { identity: identity({ toolCallId: 'another-call' }) })).toEqual({ outcome: 'conflict' })
        expect((await store.get('local-1', 'prop-1'))?.identity).toEqual(identity())
    })

    it('seals a receipt only with the current claim and proposal transition', async () => {
        const store = createSelfMcpMemoryStore()
        await seedProposal(store)
        const claim = await store.claim('local-1', 'prop-1', 1, decisionFor())
        if (claim.result !== 'transitioned') throw new Error('Expected claim')
        expect(await store.settle('local-1', claim.proposal, 'applied', receipt({ decisionId: 'foreign' }))).toEqual({ result: 'conflict' })
        expect(await store.receipts.byDecision('local-1', 'foreign')).toBeNull()
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('claimed')
        expect((await store.settle('local-1', claim.proposal, 'applied', receipt())).result).toBe('transitioned')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('applied')
        expect(await store.receipts.byDecision('local-1', 'dec-1')).toEqual(receipt())
        expect(await store.settle('local-1', claim.proposal, 'pending', receipt({ outcome: 'failed' }))).toEqual({ result: 'stale' })
        expect(await store.receipts.byDecision('local-1', 'dec-1')).toEqual(receipt())
    })

    it('keeps decisions and receipts scoped to their exact coworker even with delimiter-bearing identifiers', async () => {
        const store = createSelfMcpMemoryStore()
        await store.decisions.record('local', decisionFor({ agentId: 'local', id: '1:dec' }))
        await store.decisions.record('local:1', decisionFor({ agentId: 'local:1', id: 'dec', fingerprint: 'b'.repeat(64) }))
        expect((await store.decisions.byId('local', '1:dec'))?.fingerprint).toBe(decisionFor().fingerprint)
        expect((await store.decisions.byId('local:1', 'dec'))?.fingerprint).toBe('b'.repeat(64))
        await store.receipts.record('local', receipt({ decisionId: '1:dec' }))
        expect(await store.receipts.byDecision('local:1', 'dec')).toBeNull()
        await expect(store.decisions.record('local', decisionFor({ agentId: 'another' }))).rejects.toThrow('another coworker')
    })
})
