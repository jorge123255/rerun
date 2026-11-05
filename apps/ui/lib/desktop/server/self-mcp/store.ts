import 'server-only'
import type { SelfMcpDecision, SelfMcpProposal, SelfMcpReceipt, SelfMcpRunIdentity, SelfMcpServerInput, SelfMcpTransport } from '@rerun/contracts'

/**
 * Injected durable store for proposals, decisions and receipts. The service
 * never opens its own database: root wires a libsql implementation over the
 * central store (DDL fragment in docs/desktop-round32-h-handoff.md), and tests
 * use `createSelfMcpMemoryStore`. Every transition is a CAS on the proposal
 * revision so racing tabs and Stop/restart races converge to one result.
 */

export type SelfMcpNewProposal = {
    id: string
    agentId: string
    identity: SelfMcpRunIdentity
    fingerprint: string
    input: SelfMcpServerInput
    transport: SelfMcpTransport
    configRevision: number
    createdAt: string
}

export type SelfMcpMutation =
    | { result: 'transitioned'; proposal: SelfMcpProposal }
    | { result: 'not_found' | 'stale' | 'conflict' }

export interface SelfMcpStore {
    /** Creates a proposal, reconciles the identical invocation (same identity+fingerprint), or reports a changed body under the same identity. */
    reserve(input: SelfMcpNewProposal): Promise<{ outcome: 'created' | 'reconciled'; proposal: SelfMcpProposal } | { outcome: 'conflict' }>
    get(agentId: string, proposalId: string): Promise<SelfMcpProposal | null>
    list(agentId: string): Promise<SelfMcpProposal[]>
    /** CAS pending -> claimed on the expected proposal revision. */
    claim(agentId: string, proposalId: string, expectedRevision: number): Promise<SelfMcpMutation>
    /** CAS from -> to on the expected proposal revision. */
    transition(agentId: string, proposalId: string, expectedRevision: number, from: SelfMcpProposal['status'], to: SelfMcpProposal['status']): Promise<SelfMcpMutation>
    decisions: {
        record(agentId: string, decision: SelfMcpDecision): Promise<void>
        byProposal(agentId: string, proposalId: string): Promise<SelfMcpDecision[]>
    }
    receipts: {
        record(agentId: string, receipt: SelfMcpReceipt): Promise<void>
        byProposal(agentId: string, proposalId: string): Promise<SelfMcpReceipt[]>
        byDecision(agentId: string, decisionId: string): Promise<SelfMcpReceipt | null>
    }
}

const proposalKey = (agentId: string, proposalId: string) => `${agentId}:${proposalId}`
const identityKey = (identity: SelfMcpRunIdentity) => JSON.stringify([identity.engineAgentId, identity.sessionId, identity.runId, identity.toolCallId])

export function createSelfMcpMemoryStore(): SelfMcpStore {
    const proposals = new Map<string, SelfMcpProposal>()
    const byIdentity = new Map<string, string>()
    const decisions = new Map<string, SelfMcpDecision[]>()
    const receipts = new Map<string, SelfMcpReceipt[]>()
    const receiptsByDecision = new Map<string, SelfMcpReceipt>()

    const get = async (agentId: string, proposalId: string) => proposals.get(proposalKey(agentId, proposalId)) ?? null

    return {
        async reserve(input) {
            const existingKey = byIdentity.get(identityKey(input.identity))
            if (existingKey) {
                const existing = proposals.get(existingKey)
                if (existing) {
                    if (existing.fingerprint === input.fingerprint) return { outcome: 'reconciled', proposal: existing }
                    return { outcome: 'conflict' }
                }
            }
            const proposal: SelfMcpProposal = {
                id: input.id,
                revision: 1,
                agentId: input.agentId,
                identity: input.identity,
                fingerprint: input.fingerprint,
                input: input.input,
                transport: input.transport,
                configRevision: input.configRevision,
                status: 'pending',
                createdAt: input.createdAt,
            }
            proposals.set(proposalKey(input.agentId, input.id), proposal)
            byIdentity.set(identityKey(input.identity), proposalKey(input.agentId, input.id))
            return { outcome: 'created', proposal }
        },
        get,
        async list(agentId) {
            return [...proposals.values()].filter(proposal => proposal.agentId === agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        },
        async claim(agentId, proposalId, expectedRevision) {
            const key = proposalKey(agentId, proposalId)
            const current = proposals.get(key)
            if (!current) return { result: 'not_found' }
            if (current.revision !== expectedRevision) return { result: 'stale' }
            if (current.status !== 'pending') return { result: 'conflict' }
            const next: SelfMcpProposal = { ...current, status: 'claimed', revision: current.revision + 1 }
            proposals.set(key, next)
            return { result: 'transitioned', proposal: next }
        },
        async transition(agentId, proposalId, expectedRevision, from, to) {
            const key = proposalKey(agentId, proposalId)
            const current = proposals.get(key)
            if (!current) return { result: 'not_found' }
            if (current.revision !== expectedRevision) return { result: 'stale' }
            if (current.status !== from) return { result: 'conflict' }
            const next: SelfMcpProposal = { ...current, status: to, revision: current.revision + 1 }
            proposals.set(key, next)
            return { result: 'transitioned', proposal: next }
        },
        decisions: {
            async record(agentId, decision) {
                const key = proposalKey(agentId, decision.proposalId)
                decisions.set(key, [...(decisions.get(key) ?? []), decision])
            },
            async byProposal(agentId, proposalId) {
                return decisions.get(proposalKey(agentId, proposalId)) ?? []
            },
        },
        receipts: {
            async record(agentId, receipt) {
                const key = proposalKey(agentId, receipt.proposalId)
                receipts.set(key, [...(receipts.get(key) ?? []), receipt])
                receiptsByDecision.set(receipt.decisionId, receipt)
            },
            async byProposal(agentId, proposalId) {
                return receipts.get(proposalKey(agentId, proposalId)) ?? []
            },
            async byDecision(_agentId, decisionId) {
                return receiptsByDecision.get(decisionId) ?? null
            },
        },
    }
}
