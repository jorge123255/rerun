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
    launchEpoch: string
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
    reserve(input: SelfMcpNewProposal, assertCurrent?: () => void): Promise<{ outcome: 'created' | 'reconciled'; proposal: SelfMcpProposal } | { outcome: 'conflict' }>
    get(agentId: string, proposalId: string): Promise<SelfMcpProposal | null>
    list(agentId: string): Promise<SelfMcpProposal[]>
    /** Atomically CAS pending -> claimed and reserve the immutable decision ID/body. */
    claim(agentId: string, proposalId: string, expectedRevision: number, decision: SelfMcpDecision): Promise<SelfMcpMutation>
    /** CAS from -> to on the expected proposal revision. */
    transition(agentId: string, proposalId: string, expectedRevision: number, from: SelfMcpProposal['status'], to: SelfMcpProposal['status']): Promise<SelfMcpMutation>
    /** Atomically seals the receipt and CAS-transitions the exact proposal snapshot. */
    settle(agentId: string, proposal: SelfMcpProposal, to: SelfMcpProposal['status'], receipt: SelfMcpReceipt): Promise<SelfMcpMutation>
    decisions: {
        record(agentId: string, decision: SelfMcpDecision): Promise<void>
        byProposal(agentId: string, proposalId: string): Promise<SelfMcpDecision[]>
        byId(agentId: string, decisionId: string): Promise<SelfMcpDecision | null>
    }
    receipts: {
        record(agentId: string, receipt: SelfMcpReceipt): Promise<void>
        byProposal(agentId: string, proposalId: string): Promise<SelfMcpReceipt[]>
        byDecision(agentId: string, decisionId: string): Promise<SelfMcpReceipt | null>
    }
}

const proposalKey = (agentId: string, proposalId: string) => JSON.stringify([agentId, proposalId])
const identityKey = (identity: SelfMcpRunIdentity) => JSON.stringify([identity.engineAgentId, identity.sessionId, identity.runId, identity.toolCallId])

export function createSelfMcpMemoryStore(): SelfMcpStore {
    const proposals = new Map<string, SelfMcpProposal>()
    const byIdentity = new Map<string, string>()
    const decisions = new Map<string, SelfMcpDecision[]>()
    const decisionsById = new Map<string, SelfMcpDecision>()
    const receipts = new Map<string, SelfMcpReceipt[]>()
    const receiptsByDecision = new Map<string, SelfMcpReceipt>()

    const get = async (agentId: string, proposalId: string) => proposals.get(proposalKey(agentId, proposalId)) ?? null

    return {
        async reserve(input, assertCurrent) {
            assertCurrent?.()
            const invocation = JSON.stringify([input.agentId, identityKey(input.identity)])
            const existingKey = byIdentity.get(invocation)
            if (existingKey) {
                const existing = proposals.get(existingKey)
                if (existing) {
                    if (existing.fingerprint === input.fingerprint) return { outcome: 'reconciled', proposal: existing }
                    return { outcome: 'conflict' }
                }
            }
            if (proposals.has(proposalKey(input.agentId, input.id))) return { outcome: 'conflict' }
            const proposal: SelfMcpProposal = {
                id: input.id,
                revision: 1,
                agentId: input.agentId,
                identity: input.identity,
                launchEpoch: input.launchEpoch,
                fingerprint: input.fingerprint,
                input: input.input,
                transport: input.transport,
                configRevision: input.configRevision,
                status: 'pending',
                createdAt: input.createdAt,
            }
            proposals.set(proposalKey(input.agentId, input.id), proposal)
            byIdentity.set(invocation, proposalKey(input.agentId, input.id))
            return { outcome: 'created', proposal }
        },
        get,
        async list(agentId) {
            return [...proposals.values()].filter(proposal => proposal.agentId === agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        },
        async claim(agentId, proposalId, expectedRevision, decision) {
            const key = proposalKey(agentId, proposalId)
            const current = proposals.get(key)
            if (!current) return { result: 'not_found' }
            if (current.revision !== expectedRevision) return { result: 'stale' }
            if (current.status !== 'pending') return { result: 'conflict' }
            if (decision.agentId !== agentId || decision.proposalId !== proposalId || decision.proposalRevision !== expectedRevision
                || decision.fingerprint !== current.fingerprint || identityKey(decision.identity) !== identityKey(current.identity)) return { result: 'conflict' }
            if (decisionsById.has(proposalKey(agentId, decision.id))) return { result: 'conflict' }
            const next: SelfMcpProposal = { ...current, status: 'claimed', revision: current.revision + 1 }
            decisionsById.set(proposalKey(agentId, decision.id), decision)
            decisions.set(key, [...(decisions.get(key) ?? []), decision])
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
        async settle(agentId, proposal, to, receipt) {
            const key = proposalKey(agentId, proposal.id)
            const current = proposals.get(key)
            if (!current) return { result: 'not_found' }
            if (current.revision !== proposal.revision) return { result: 'stale' }
            if (current.status !== proposal.status || receipt.proposalId !== proposal.id) return { result: 'conflict' }
            const decisionKey = proposalKey(agentId, receipt.decisionId)
            if (receiptsByDecision.has(decisionKey)) return { result: 'conflict' }
            if (current.status === 'claimed' || current.status === 'uncertain') {
                const decision = decisionsById.get(decisionKey)
                if (!decision || decision.proposalId !== proposal.id || decisions.get(key)?.at(-1)?.id !== decision.id) return { result: 'conflict' }
            }
            const next: SelfMcpProposal = { ...current, status: to, revision: current.revision + 1 }
            receipts.set(key, [...(receipts.get(key) ?? []), receipt])
            receiptsByDecision.set(decisionKey, receipt)
            proposals.set(key, next)
            return { result: 'transitioned', proposal: next }
        },
        decisions: {
            async record(agentId, decision) {
                if (decision.agentId !== agentId) throw new Error('Decision belongs to another coworker')
                const key = proposalKey(agentId, decision.proposalId)
                const id = proposalKey(agentId, decision.id)
                const existing = decisionsById.get(id)
                if (existing) {
                    if (JSON.stringify(existing) !== JSON.stringify(decision)) throw new Error('Decision identity already belongs to another review')
                    return
                }
                decisionsById.set(id, decision)
                decisions.set(key, [...(decisions.get(key) ?? []), decision])
            },
            async byProposal(agentId, proposalId) {
                return decisions.get(proposalKey(agentId, proposalId)) ?? []
            },
            async byId(agentId, decisionId) { return decisionsById.get(proposalKey(agentId, decisionId)) ?? null },
        },
        receipts: {
            async record(agentId, receipt) {
                const key = proposalKey(agentId, receipt.proposalId)
                const id = proposalKey(agentId, receipt.decisionId)
                const existing = receiptsByDecision.get(id)
                if (existing) {
                    if (JSON.stringify(existing) !== JSON.stringify(receipt)) throw new Error('Decision receipt is already sealed')
                    return
                }
                receipts.set(key, [...(receipts.get(key) ?? []), receipt])
                receiptsByDecision.set(id, receipt)
            },
            async byProposal(agentId, proposalId) {
                return receipts.get(proposalKey(agentId, proposalId)) ?? []
            },
            async byDecision(agentId, decisionId) {
                return receiptsByDecision.get(proposalKey(agentId, decisionId)) ?? null
            },
        },
    }
}
