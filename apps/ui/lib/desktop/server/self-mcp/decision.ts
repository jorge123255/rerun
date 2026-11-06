import 'server-only'
import type { SelfMcpDecision, SelfMcpDecisionRequest, SelfMcpDecisionResult, SelfMcpProposal, SelfMcpReceipt, SelfMcpReceiptOutcome } from '@rerun/contracts'
import type { SelfMcpApplyIdentity, SelfMcpApplyReceipt, SelfMcpApplyResult, SelfMcpAuthority, SelfMcpConfigAdapter, SelfMcpEffectContext, SelfMcpOwner, SelfMcpProbeAdapter, SelfMcpServerCandidate } from './adapters'
import type { SelfMcpStore } from './store'

export type SelfMcpDecisionDeps = {
    store: SelfMcpStore
    authority: SelfMcpAuthority
    config: SelfMcpConfigAdapter
    probe: SelfMcpProbeAdapter
    now: () => string
    newId: () => string
    deadlineMs?: number
}

export class SelfMcpProposalNotFoundError extends Error {
    constructor() { super('Proposal not found') }
}
export class SelfMcpStaleProposalError extends Error {
    constructor() { super('The proposal changed; refresh and review it again.') }
}
class SelfMcpAuthorityError extends Error {
    constructor() { super('The source run was stopped, replaced, or its permission was revoked.') }
}

const sourceKey = (decision: SelfMcpDecision) => JSON.stringify([
    decision.agentId, decision.proposalId, decision.proposalRevision, decision.configRevision,
    decision.identity.engineAgentId, decision.identity.sessionId, decision.identity.runId, decision.identity.toolCallId,
    decision.fingerprint, decision.outcome.kind, decision.outcome.kind === 'rejected' ? decision.outcome.reason ?? null : null,
])
const rejectionDetail = (reason?: string) => 'The proposal was rejected; nothing was saved.' + (reason ? ` ${reason}` : '')

function receipt(deps: SelfMcpDecisionDeps, proposal: SelfMcpProposal, decisionId: string, outcome: SelfMcpReceiptOutcome, configRevision: number, detail?: string): SelfMcpReceipt {
    return { id: deps.newId(), proposalId: proposal.id, decisionId, outcome, configRevision, ...(detail ? { detail } : {}), createdAt: deps.now() }
}
function result(outcome: SelfMcpDecisionResult['outcome'], proposal: SelfMcpProposal, message: string, row?: SelfMcpReceipt, requirements: string[] = []): SelfMcpDecisionResult {
    return { outcome, proposalId: proposal.id, proposalRevision: proposal.revision, message, ...(row ? { receipt: row } : {}), requirements }
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Review expired')) }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort()
    })
}

export async function currentSelfMcpOwner(deps: Pick<SelfMcpDecisionDeps, 'authority'>, proposal: Pick<SelfMcpProposal, 'agentId' | 'identity' | 'launchEpoch'>): Promise<SelfMcpOwner> {
    const owner = await deps.authority.currentOwner(proposal.agentId, proposal.identity, proposal.launchEpoch)
    if (!owner || owner.agentId !== proposal.agentId || owner.engineAgentId !== proposal.identity.engineAgentId || owner.launchEpoch !== proposal.launchEpoch
        || !owner.enabled || owner.deleting || !owner.selfImprovementEnabled || !owner.selfMcpGranted) throw new SelfMcpAuthorityError()
    return owner
}

export function selfMcpRequirements(deps: SelfMcpDecisionDeps, owner: SelfMcpOwner, proposal: SelfMcpProposal): string[] {
    const requirements: string[] = [...(deps.config.requirements?.({ ...proposal.input, transport: proposal.transport }) ?? [])]
    if (proposal.transport === 'sse' && !deps.probe.transports.includes('sse')) requirements.push('SSE transport is provided by a separate capability that is not available in this runtime.')
    if (proposal.transport === 'http' && !deps.probe.transports.includes('http')) requirements.push('HTTP probing is unavailable in this runtime.')
    if (proposal.transport !== 'stdio' && !owner.remoteMcpGranted) requirements.push('Remote MCP access requires the separate MCP permission.')
    if (proposal.transport === 'stdio' && !owner.localMcpStdioGranted) requirements.push('Local program execution requires the separate Local MCP programs permission. Nothing is launched or installed when saving.')
    return requirements
}

async function converged(deps: SelfMcpDecisionDeps, agentId: string, proposal: SelfMcpProposal, decisionId?: string): Promise<SelfMcpDecisionResult> {
    const row = decisionId ? await deps.store.receipts.byDecision(agentId, decisionId) ?? undefined : (await deps.store.receipts.byProposal(agentId, proposal.id)).at(-1)
    if (row) return result(row.outcome, proposal, proposal.status === 'applied' ? 'This server is already saved. ' + (row.detail ?? '') : row.detail ?? 'This decision is already recorded.', row)
    if (proposal.status === 'claimed') return result('in_flight', proposal, 'Another review is being processed; refresh to see its result.')
    if (proposal.status === 'applied') return result('applied_unverified', proposal, 'This server is already saved; connectivity is unverified.')
    if (proposal.status === 'rejected' || proposal.status === 'cancelled') return result(proposal.status, proposal, 'This proposal is already closed.')
    return result('failed', proposal, 'The outcome is uncertain; refresh to recover the saved decision.')
}

async function settle(deps: SelfMcpDecisionDeps, proposal: SelfMcpProposal, decisionId: string, status: SelfMcpProposal['status'], outcome: SelfMcpReceiptOutcome, configRevision: number, detail: string, requirements: string[] = []): Promise<SelfMcpDecisionResult> {
    const row = receipt(deps, proposal, decisionId, outcome, configRevision, detail)
    const saved = await deps.store.settle(proposal.agentId, proposal, status, row)
    if (saved.result === 'transitioned') return result(outcome, saved.proposal, detail, row, requirements)
    const current = await deps.store.get(proposal.agentId, proposal.id)
    if (!current) throw new SelfMcpProposalNotFoundError()
    return converged(deps, proposal.agentId, current, decisionId)
}

function validApplyReceipt(expected: SelfMcpApplyIdentity, saved: SelfMcpApplyReceipt): boolean {
    return saved.launchEpoch === expected.launchEpoch && saved.decision.id === expected.decision.id
        && sourceKey(saved.decision) === sourceKey(expected.decision) && saved.configRevision > expected.decision.configRevision
}

export async function reconcileSelfMcpProposal(deps: SelfMcpDecisionDeps, agentId: string, proposal: SelfMcpProposal): Promise<SelfMcpProposal> {
    if (proposal.status !== 'claimed' && proposal.status !== 'uncertain') return proposal
    const decision = (await deps.store.decisions.byProposal(agentId, proposal.id)).at(-1)
    if (!decision) {
        const saved = await deps.store.transition(agentId, proposal.id, proposal.revision, proposal.status, 'pending')
        return saved.result === 'transitioned' ? saved.proposal : proposal
    }
    if (decision.outcome.kind === 'rejected') {
        await settle(deps, proposal, decision.id, 'rejected', 'rejected', decision.configRevision, rejectionDetail(decision.outcome.reason))
        return await deps.store.get(agentId, proposal.id) ?? proposal
    }
    const identity = { decision, launchEpoch: proposal.launchEpoch }
    const recovery = await bounded(deps.config.recover(agentId, identity), AbortSignal.timeout(deps.deadlineMs ?? 15_000))
    if (recovery.state === 'uncertain') return proposal
    if (recovery.state === 'applied') {
        if (!validApplyReceipt(identity, recovery.receipt)) throw new Error('The configuration receipt belongs to another decision')
        await settle(deps, proposal, decision.id, 'applied', recovery.receipt.outcome, recovery.receipt.configRevision, recovery.receipt.detail)
    } else {
        await settle(deps, proposal, decision.id, 'pending', 'failed', decision.configRevision, 'Nothing was saved; review this proposal again.')
    }
    return await deps.store.get(agentId, proposal.id) ?? proposal
}

export async function reconcileSelfMcpProposals(deps: SelfMcpDecisionDeps, agentId: string, options: { includeClaimed?: boolean } = {}): Promise<void> {
    for (const proposal of await deps.store.list(agentId)) {
        if (proposal.status === 'uncertain' || (options.includeClaimed && proposal.status === 'claimed')) await reconcileSelfMcpProposal(deps, agentId, proposal)
    }
}

export async function dismissSelfMcpProposal(deps: SelfMcpDecisionDeps, agentId: string, proposalId: string, expectedProposalRevision: number): Promise<SelfMcpDecisionResult> {
    const proposal = await deps.store.get(agentId, proposalId)
    if (!proposal) throw new SelfMcpProposalNotFoundError()
    if (proposal.status !== 'pending') return converged(deps, agentId, proposal)
    if (proposal.revision !== expectedProposalRevision) throw new SelfMcpStaleProposalError()
    return settle(deps, proposal, deps.newId(), 'cancelled', 'cancelled', proposal.configRevision, 'The proposal was cancelled without saving.')
}

export async function decideSelfMcpProposal(deps: SelfMcpDecisionDeps, agentId: string, request: SelfMcpDecisionRequest, stop?: AbortSignal): Promise<SelfMcpDecisionResult> {
    const found = await deps.store.get(agentId, request.proposalId)
    if (!found) throw new SelfMcpProposalNotFoundError()
    let proposal: SelfMcpProposal = found
    const decision: SelfMcpDecision = {
        id: request.decisionId, proposalId: proposal.id, proposalRevision: request.expectedProposalRevision,
        configRevision: request.expectedConfigRevision, identity: proposal.identity, fingerprint: proposal.fingerprint,
        outcome: request.outcome, agentId, decidedAt: deps.now(),
    }
    const prior = await deps.store.decisions.byId(agentId, request.decisionId)
    if (prior && sourceKey(prior) !== sourceKey(decision)) throw new SelfMcpStaleProposalError()
    if (proposal.status === 'uncertain') proposal = await reconcileSelfMcpProposal(deps, agentId, proposal)
    if (prior || proposal.status !== 'pending') return converged(deps, agentId, proposal, prior ? request.decisionId : undefined)
    if (proposal.revision !== request.expectedProposalRevision) throw new SelfMcpStaleProposalError()
    const watch = await deps.authority.watch?.(agentId, proposal.identity)
    let claim: Awaited<ReturnType<SelfMcpStore['claim']>>
    try { claim = await deps.store.claim(agentId, proposal.id, request.expectedProposalRevision, decision) }
    catch (error) {
        const current = await deps.store.get(agentId, proposal.id)
        const reserved = await deps.store.decisions.byId(agentId, decision.id)
        if (current?.status === 'claimed' && reserved && sourceKey(reserved) === sourceKey(decision)) {
            await deps.store.transition(agentId, current.id, current.revision, 'claimed', 'uncertain')
        }
        throw error
    }
    if (claim.result === 'not_found') throw new SelfMcpProposalNotFoundError()
    if (claim.result === 'stale') throw new SelfMcpStaleProposalError()
    if (claim.result !== 'transitioned') return converged(deps, agentId, await deps.store.get(agentId, proposal.id) ?? proposal)
    proposal = claim.proposal
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(deps.deadlineMs ?? 15_000)])
    const assertCommit = () => { signal.throwIfAborted(); watch?.() }
    let applyStarted = false
    const context: SelfMcpEffectContext = {
        signal,
        assertCommit,
        assertCurrent: async () => {
            assertCommit()
            const current = await currentSelfMcpOwner(deps, proposal)
            if (selfMcpRequirements(deps, current, proposal).length) throw new SelfMcpAuthorityError()
            if ((await deps.config.reviewRequirements?.(agentId, { ...proposal.input, transport: proposal.transport }))?.length) throw new SelfMcpAuthorityError()
            if ((await deps.config.managedNames(agentId)).includes(proposal.input.name)) throw new SelfMcpAuthorityError()
            await currentSelfMcpOwner(deps, proposal)
            assertCommit()
        },
    }
    try {
        const owner = await bounded(currentSelfMcpOwner(deps, proposal), signal)
        if (request.outcome.kind === 'rejected') return await settle(deps, proposal, decision.id, 'rejected', 'rejected', request.expectedConfigRevision, rejectionDetail(request.outcome.reason))
        const currentRevision = await bounded(deps.config.revision(agentId), signal)
        if (currentRevision !== request.expectedConfigRevision) return await settle(deps, proposal, decision.id, 'pending', 'failed', currentRevision, 'The configuration changed; refresh and review it again.')
        const requirements = selfMcpRequirements(deps, owner, proposal)
        requirements.push(...await deps.config.reviewRequirements?.(agentId, { ...proposal.input, transport: proposal.transport }) ?? [])
        if ((await bounded(deps.config.managedNames(agentId), signal)).includes(proposal.input.name)) requirements.push('This server name is managed by a connected app/service and cannot be replaced by a proposal.')
        if (requirements.length) return await settle(deps, proposal, decision.id, 'pending', 'failed', currentRevision, requirements.join(' '), requirements)
        const server: SelfMcpServerCandidate = { ...proposal.input, transport: proposal.transport }
        let applied: SelfMcpApplyResult = { outcome: 'applied_unverified', detail: proposal.transport === 'stdio' ? 'Saved without launching the program; connectivity is unverified.' : 'Saved without probing; connectivity is unverified.' }
        if (proposal.transport === 'http') {
            await bounded(context.assertCurrent(), signal)
            const probe = await bounded(deps.probe.probe(agentId, server, context), signal)
            await bounded(context.assertCurrent(), signal)
            if (probe.ok) applied = { outcome: 'applied', detail: 'The server was saved and verified: ' + probe.toolNames.length + ' tools probed.' }
            else if (probe.credentialsRejected) return await settle(deps, proposal, decision.id, 'pending', 'failed', currentRevision, 'The server rejected the credentials. Nothing was saved; provide valid credentials before trying again.')
            else if (probe.needsCredentials) applied = { outcome: 'applied_pending_credentials', detail: 'The server was saved but needs sign-in before its tools work.' }
            else if (probe.needsPermission) applied = { outcome: 'applied_unverified', detail: 'The server was saved but requires permission before its tools connect.' }
            else return await settle(deps, proposal, decision.id, 'pending', 'failed', currentRevision, 'Could not connect to the server. Nothing was saved; review its address and try again.')
        }
        await bounded(context.assertCurrent(), signal)
        applyStarted = true
        const expected = { decision, launchEpoch: proposal.launchEpoch }
        const saved = await bounded(deps.config.apply(agentId, server, expected, context, applied), signal)
        if (!validApplyReceipt(expected, saved)) throw new Error('The configuration receipt belongs to another decision')
        return await settle(deps, proposal, decision.id, 'applied', saved.outcome, saved.configRevision, saved.detail)
    } catch (error) {
        const current = await deps.store.get(agentId, proposal.id)
        if (!current) throw new SelfMcpProposalNotFoundError()
        if (current.status !== 'claimed') return converged(deps, agentId, current, decision.id)
        if (applyStarted) {
            await deps.store.transition(agentId, current.id, current.revision, 'claimed', 'uncertain')
            return result('failed', await deps.store.get(agentId, current.id) ?? current, 'The save acknowledgement is uncertain. Refresh to recover this exact decision.')
        }
        const cancelled = error instanceof SelfMcpAuthorityError || stop?.aborted
        return settle(deps, current, decision.id, cancelled ? 'cancelled' : 'pending', cancelled ? 'cancelled' : 'failed', request.expectedConfigRevision,
            cancelled ? 'The source run was stopped or its permission was revoked; nothing was saved.' : 'The connection check could not finish; nothing was saved. Review and try again.')
    }
}
