import 'server-only'
import type { Client, Transaction } from '@libsql/client'
import { selfMcpDecisionSchema, selfMcpProposalSchema, selfMcpReceiptSchema, type SelfMcpDecision, type SelfMcpProposal, type SelfMcpReceipt, type SelfMcpRunIdentity } from '@rerun/contracts'
import type { SelfMcpStore, SelfMcpMutation } from './store'

export const selfMcpInvocation = (identity: SelfMcpRunIdentity) => JSON.stringify([identity.engineAgentId, identity.sessionId, identity.runId, identity.toolCallId])
export function createSelfMcpSqlStore(db: Client): SelfMcpStore {
    const get = async (owner: string, id: string, executor: Client | Transaction = db) => {
        const row = (await executor.execute({ sql: 'SELECT body FROM desktop_self_mcp_proposals WHERE owner=? AND id=?', args: [owner, id] })).rows[0]
        return row ? selfMcpProposalSchema.parse(JSON.parse(String(row.body))) : null
    }
    const transact = async <T>(work: (tx: Transaction) => Promise<T>, beforeCommit?: () => void) => {
        const tx = await db.transaction('write')
        try { const result = await work(tx); beforeCommit?.(); await tx.commit(); return result } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
    }
    const transition = async (tx: Transaction, owner: string, current: SelfMcpProposal, status: SelfMcpProposal['status']): Promise<SelfMcpMutation> => {
        const next = { ...current, status, revision: current.revision + 1 }
        const result = await tx.execute({ sql: 'UPDATE desktop_self_mcp_proposals SET revision=?,status=?,body=? WHERE owner=? AND id=? AND revision=? AND status=?', args: [next.revision, status, JSON.stringify(next), owner, current.id, current.revision, current.status] })
        return result.rowsAffected === 1 ? { result: 'transitioned', proposal: next } : { result: 'stale' }
    }
    const readDecision = async (owner: string, id: string, executor: Client | Transaction = db) => {
        const row = (await executor.execute({ sql: 'SELECT body FROM desktop_self_mcp_decisions WHERE owner=? AND id=?', args: [owner, id] })).rows[0]
        return row ? selfMcpDecisionSchema.parse(JSON.parse(String(row.body))) : null
    }
    const readReceipt = async (owner: string, id: string, executor: Client | Transaction = db) => {
        const row = (await executor.execute({ sql: 'SELECT body FROM desktop_self_mcp_receipts WHERE owner=? AND decision_id=?', args: [owner, id] })).rows[0]
        return row ? selfMcpReceiptSchema.parse(JSON.parse(String(row.body))) : null
    }
    return {
        get,
        async list(owner) { return (await db.execute({ sql: 'SELECT body FROM desktop_self_mcp_proposals WHERE owner=? ORDER BY rowid LIMIT 501', args: [owner] })).rows.map(row => selfMcpProposalSchema.parse(JSON.parse(String(row.body)))) },
        reserve: (input, assertCurrent) => transact(async tx => {
            assertCurrent?.()
            const invocation = selfMcpInvocation(input.identity)
            const row = (await tx.execute({ sql: 'SELECT body FROM desktop_self_mcp_proposals WHERE owner=? AND invocation=?', args: [input.agentId, invocation] })).rows[0]
            if (row) { const proposal = selfMcpProposalSchema.parse(JSON.parse(String(row.body))); return proposal.fingerprint === input.fingerprint ? { outcome: 'reconciled' as const, proposal } : { outcome: 'conflict' as const } }
            const count = Number((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_self_mcp_proposals WHERE owner=?', args: [input.agentId] })).rows[0].n)
            if (count >= 500) throw new Error('This coworker has reached the MCP proposal limit.')
            const proposal = selfMcpProposalSchema.parse({ ...input, revision: 1, status: 'pending' })
            const written = await tx.execute({ sql: 'INSERT INTO desktop_self_mcp_proposals(owner,id,invocation,revision,status,body) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', args: [input.agentId, input.id, invocation, 1, 'pending', JSON.stringify(proposal)] })
            assertCurrent?.()
            return written.rowsAffected === 1 ? { outcome: 'created' as const, proposal } : { outcome: 'conflict' as const }
        }, assertCurrent),
        claim: (owner, id, revision, raw) => transact<SelfMcpMutation>(async tx => {
            const current = await get(owner, id, tx), decision = selfMcpDecisionSchema.parse(raw)
            if (!current) return { result: 'not_found' }
            if (current.revision !== revision) return { result: 'stale' }
            if (current.status !== 'pending' || decision.agentId !== owner || decision.proposalId !== id || decision.proposalRevision !== revision || decision.fingerprint !== current.fingerprint || selfMcpInvocation(decision.identity) !== selfMcpInvocation(current.identity) || await readDecision(owner, decision.id, tx)) return { result: 'conflict' }
            await tx.execute({ sql: 'INSERT INTO desktop_self_mcp_decisions(owner,id,proposal_id,body) VALUES(?,?,?,?)', args: [owner, decision.id, id, JSON.stringify(decision)] })
            return transition(tx, owner, current, 'claimed')
        }),
        transition: (owner, id, revision, from, to) => transact<SelfMcpMutation>(async tx => {
            const current = await get(owner, id, tx)
            if (!current) return { result: 'not_found' }
            if (current.revision !== revision) return { result: 'stale' }
            if (current.status !== from) return { result: 'conflict' }
            return transition(tx, owner, current, to)
        }),
        settle: (owner, proposal, to, raw) => transact<SelfMcpMutation>(async tx => {
            const current = await get(owner, proposal.id, tx), receipt = selfMcpReceiptSchema.parse(raw)
            if (!current) return { result: 'not_found' }
            if (current.revision !== proposal.revision) return { result: 'stale' }
            if (current.status !== proposal.status || current.agentId !== owner || receipt.proposalId !== current.id || await readReceipt(owner, receipt.decisionId, tx)) return { result: 'conflict' }
            if (current.status === 'claimed' || current.status === 'uncertain') {
                const decision = await readDecision(owner, receipt.decisionId, tx)
                const last = (await tx.execute({ sql: 'SELECT id FROM desktop_self_mcp_decisions WHERE owner=? AND proposal_id=? ORDER BY rowid DESC LIMIT 1', args: [owner, current.id] })).rows[0]
                if (!decision || decision.proposalId !== current.id || last?.id !== decision.id) return { result: 'conflict' }
            }
            await tx.execute({ sql: 'INSERT INTO desktop_self_mcp_receipts(owner,decision_id,proposal_id,body) VALUES(?,?,?,?)', args: [owner, receipt.decisionId, current.id, JSON.stringify(receipt)] })
            return transition(tx, owner, current, to)
        }),
        decisions: {
            byId: readDecision,
            async byProposal(owner, id) { return (await db.execute({ sql: 'SELECT body FROM desktop_self_mcp_decisions WHERE owner=? AND proposal_id=? ORDER BY rowid', args: [owner, id] })).rows.map(row => selfMcpDecisionSchema.parse(JSON.parse(String(row.body)))) },
            record: (owner: string, raw: SelfMcpDecision) => transact(async tx => {
                const value = selfMcpDecisionSchema.parse(raw), prior = await readDecision(owner, value.id, tx)
                if (value.agentId !== owner || prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('MCP decision identity changed')
                if (!prior) await tx.execute({ sql: 'INSERT INTO desktop_self_mcp_decisions(owner,id,proposal_id,body) VALUES(?,?,?,?)', args: [owner, value.id, value.proposalId, JSON.stringify(value)] })
            }),
        },
        receipts: {
            byDecision: readReceipt,
            async byProposal(owner, id) { return (await db.execute({ sql: 'SELECT body FROM desktop_self_mcp_receipts WHERE owner=? AND proposal_id=? ORDER BY rowid', args: [owner, id] })).rows.map(row => selfMcpReceiptSchema.parse(JSON.parse(String(row.body)))) },
            record: (owner: string, raw: SelfMcpReceipt) => transact(async tx => {
                const value = selfMcpReceiptSchema.parse(raw), prior = await readReceipt(owner, value.decisionId, tx)
                if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('MCP decision receipt changed')
                if (!prior) await tx.execute({ sql: 'INSERT INTO desktop_self_mcp_receipts(owner,decision_id,proposal_id,body) VALUES(?,?,?,?)', args: [owner, value.decisionId, value.proposalId, JSON.stringify(value)] })
            }),
        },
    }
}
