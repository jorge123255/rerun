import 'server-only'
import type { SelfMcpDecision, SelfMcpDecisionRequest, SelfMcpDecisionResult, SelfMcpProposal, SelfMcpReceipt, SelfMcpReceiptOutcome } from '@rerun/contracts'
import type { SelfMcpAuthority, SelfMcpConfigAdapter, SelfMcpOwner, SelfMcpProbeAdapter, SelfMcpServerCandidate } from './adapters'
import type { SelfMcpStore } from './store'

/**
 * The trusted decision boundary. Only an explicit local human decision reaches
 * this module. Every decision binds the proposal revision, the fingerprint and
 * the expected configuration revision, CAS-reserves the proposal transition,
 * then re-checks authority fresh immediately before each probe/save effect.
 * Unsupported transports and missing separate local-program grants are visible
 * requirements that this decision can never silently enable.
 */

export type SelfMcpDecisionDeps = {
    store: SelfMcpStore
    authority: SelfMcpAuthority
    config: SelfMcpConfigAdapter
    probe: SelfMcpProbeAdapter
    now: () => string
    newId: () => string
}

export class SelfMcpProposalNotFoundError extends Error {
    constructor() { super('Proposal not found') }
}
export class SelfMcpStaleProposalError extends Error {
    constructor() { super('The proposal changed; refresh and review it again.') }
}

const ownerOk = (owner: SelfMcpOwner) => owner.enabled && !owner.deleting && owner.selfImprovementEnabled && owner.selfMcpGranted

function receipt(deps: SelfMcpDecisionDeps, proposal: SelfMcpProposal, decisionId: string, outcome: SelfMcpReceiptOutcome, configRevision: number, detail?: string): SelfMcpReceipt {
    return { id: deps.newId(), proposalId: proposal.id, decisionId, outcome, configRevision, ...(detail ? { detail } : {}), createdAt: deps.now() }
}

function result(outcome: SelfMcpDecisionResult['outcome'], proposal: SelfMcpProposal, message: string, receiptRow?: SelfMcpReceipt, requirements: string[] = []): SelfMcpDecisionResult {
    return { outcome, proposalId: proposal.id, proposalRevision: proposal.revision, message, ...(receiptRow ? { receipt: receiptRow } : {}), requirements }
}

/** Visible requirements that a proposal (or a decision) must not silently skip. */
export function selfMcpRequirements(deps: SelfMcpDecisionDeps, owner: SelfMcpOwner, proposal: SelfMcpProposal): string[] {
    const requirements: string[] = []
    if (proposal.transport === 'sse' && !deps.probe.transports.includes('sse')) {
        requirements.push('SSE transport is provided by a separate capability that is not available in this runtime.')
    }
    if (proposal.transport === 'http' && !deps.probe.transports.includes('http')) {
        requirements.push('HTTP probing is unavailable in this runtime.')
    }
    if (proposal.transport === 'stdio' && !owner.localMcpStdioGranted) {
        requirements.push('Local program execution requires the separate Local MCP programs permission. Nothing is launched or installed when saving.')
    }
    return requirements
}

async function converged(deps: SelfMcpDecisionDeps, agentId: string, proposal: SelfMcpProposal): Promise<SelfMcpDecisionResult> {
    const receipts = await deps.store.receipts.byProposal(agentId, proposal.id)
    const last = receipts[receipts.length - 1]
    if (proposal.status === 'applied') {
        const outcome = last?.outcome === 'applied_pending_credentials' || last?.outcome === 'applied_unverified' ? last.outcome : 'applied'
        return result(outcome, proposal, 'This server is already saved.', last)
    }
    if (proposal.status === 'rejected') return result('rejected', proposal, 'This proposal was rejected.', last)
    if (proposal.status === 'cancelled') return result('cancelled', proposal, 'This proposal was cancelled without saving.', last)
    return result('failed', proposal, 'The outcome is uncertain; refresh to recover it.', last)
}

async function latestReceipt(deps: SelfMcpDecisionDeps, agentId: string, proposalId: string): Promise<SelfMcpReceipt | undefined> {
    return (await deps.store.receipts.byProposal(agentId, proposalId)).at(-1)
}

/**
 * Reconciles a claimed/uncertain proposal on restart or refresh. Never
 * auto-approves, probes, logs in or executes: if the trusted configuration
 * already holds the exact server it is durably acknowledged (never re-applied);
 * otherwise the proposal returns to pending so the human decides again. A
 * failed save stays durably recorded by its failed receipt.
 */
export async function reconcileSelfMcpProposal(deps: SelfMcpDecisionDeps, agentId: string, proposal: SelfMcpProposal): Promise<SelfMcpProposal> {
    if (proposal.status !== 'claimed' && proposal.status !== 'uncertain') return proposal
    const server: SelfMcpServerCandidate = { ...proposal.input, transport: proposal.transport }
    const present = await deps.config.hasServer(agentId, server)
    if (present) {
        const transitioned = await deps.store.transition(agentId, proposal.id, proposal.revision, proposal.status, 'applied')
        if (transitioned.result === 'transitioned') {
            const decision = (await deps.store.decisions.byProposal(agentId, proposal.id)).at(-1)
            await deps.store.receipts.record(agentId, receipt(deps, transitioned.proposal, decision?.id ?? deps.newId(), 'applied_unverified', proposal.configRevision, 'Acknowledged after restart: the exact server is present in the trusted configuration.'))
            return transitioned.proposal
        }
        return proposal
    }
    // Nothing was applied: release back to pending. A restart never auto-applies.
    const transitioned = await deps.store.transition(agentId, proposal.id, proposal.revision, proposal.status, 'pending')
    return transitioned.result === 'transitioned' ? transitioned.proposal : proposal
}

/**
 * Recovers unsettled proposals. Live refreshes only resolve `uncertain` rows; a
 * live `claimed` row is an in-flight decision and must not be touched. Root
 * calls this with `includeClaimed: true` once at startup, after a restart, when
 * any leftover `claimed` row is by definition an unacknowledged decision.
 */
export async function reconcileSelfMcpProposals(deps: SelfMcpDecisionDeps, agentId: string, options: { includeClaimed?: boolean } = {}): Promise<void> {
    for (const proposal of await deps.store.list(agentId)) {
        if (proposal.status === 'uncertain' || (options.includeClaimed === true && proposal.status === 'claimed')) {
            await reconcileSelfMcpProposal(deps, agentId, proposal)
        }
    }
}

export async function dismissSelfMcpProposal(deps: SelfMcpDecisionDeps, agentId: string, proposalId: string, expectedProposalRevision: number): Promise<SelfMcpDecisionResult> {
    const proposal = await deps.store.get(agentId, proposalId)
    if (!proposal) throw new SelfMcpProposalNotFoundError()
    if (proposal.status !== 'pending') return converged(deps, agentId, proposal)
    const transitioned = await deps.store.transition(agentId, proposalId, expectedProposalRevision, 'pending', 'cancelled')
    if (transitioned.result === 'stale') throw new SelfMcpStaleProposalError()
    if (transitioned.result === 'conflict') return converged(deps, agentId, proposal)
    if (transitioned.result === 'not_found') throw new SelfMcpProposalNotFoundError()
    await deps.store.receipts.record(agentId, receipt(deps, transitioned.proposal, deps.newId(), 'cancelled', proposal.configRevision, 'The proposal was cancelled without saving.'))
    return result('cancelled', transitioned.proposal, 'The proposal was cancelled without saving.', await latestReceipt(deps, agentId, proposalId))
}

export async function decideSelfMcpProposal(deps: SelfMcpDecisionDeps, agentId: string, request: SelfMcpDecisionRequest): Promise<SelfMcpDecisionResult> {
    let proposal = await deps.store.get(agentId, request.proposalId)
    if (!proposal) throw new SelfMcpProposalNotFoundError()

    // Repeated or racing decisions converge to one result. Terminal states return their
    // durable outcome; a live claimed row is another in-flight decision; an uncertain row
    // recovers first (never auto-applying).
    if (proposal.status === 'applied' || proposal.status === 'rejected' || proposal.status === 'cancelled') {
        return converged(deps, agentId, proposal)
    }
    if (proposal.status === 'claimed') {
        return result('in_flight', proposal, 'Another review is being processed; refresh to see its result.')
    }
    if (proposal.status === 'uncertain') {
        const recovered = await reconcileSelfMcpProposal(deps, agentId, proposal)
        if (recovered.status !== 'pending') return converged(deps, agentId, recovered)
        proposal = recovered
    }

    // CAS-reserve the decision before any effect.
    const claim = await deps.store.claim(agentId, proposal.id, request.expectedProposalRevision)
    if (claim.result === 'not_found') throw new SelfMcpProposalNotFoundError()
    if (claim.result === 'stale') throw new SelfMcpStaleProposalError()
    if (claim.result === 'conflict') {
        const current = await deps.store.get(agentId, proposal.id)
        if (!current) throw new SelfMcpProposalNotFoundError()
        if (current.status === 'claimed') return result('in_flight', current, 'Another review is being processed; refresh to see its result.')
        return converged(deps, agentId, current)
    }
    proposal = claim.proposal

    const decision: SelfMcpDecision = {
        id: deps.newId(),
        proposalId: proposal.id,
        proposalRevision: proposal.revision,
        configRevision: request.expectedConfigRevision,
        identity: proposal.identity,
        fingerprint: proposal.fingerprint,
        outcome: request.outcome,
        agentId,
        decidedAt: deps.now(),
    }
    await deps.store.decisions.record(agentId, decision)

    // Fresh admission before any effect: Stop before a decision prevents later commit, and a
    // late decision cannot resurrect a deleted/replaced owner or a cancelled run.
    const owner = await deps.authority.currentOwner(agentId).catch(() => null)
    if (!owner || !ownerOk(owner)) {
        await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'cancelled')
        const cancelled = await deps.store.get(agentId, proposal.id)
        await deps.store.receipts.record(agentId, receipt(deps, cancelled ?? proposal, decision.id, 'cancelled', request.expectedConfigRevision, 'The coworker was stopped or the self-MCP permission was revoked before this decision.'))
        return result('cancelled', cancelled ?? proposal, 'The coworker was stopped or the permission was revoked.', await latestReceipt(deps, agentId, proposal.id))
    }

    if (request.outcome.kind === 'rejected') {
        const rejected = await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'rejected')
        if (rejected.result !== 'transitioned') return result('failed', proposal, 'The proposal changed while deciding; refresh and review it again.')
        await deps.store.receipts.record(agentId, receipt(deps, rejected.proposal, decision.id, 'rejected', request.expectedConfigRevision, request.outcome.reason ?? 'Rejected by the user.'))
        return result('rejected', rejected.proposal, 'The proposal was rejected; nothing was saved.', await latestReceipt(deps, agentId, proposal.id))
    }

    // Approved: CAS the exact configuration revision rather than applying a second registration.
    const currentRevision = await deps.config.revision(agentId)
    if (currentRevision !== request.expectedConfigRevision) {
        await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'pending')
        await deps.store.receipts.record(agentId, receipt(deps, proposal, decision.id, 'failed', currentRevision, 'The configuration changed since this proposal; review it again.'))
        return result('failed', await deps.store.get(agentId, proposal.id) ?? proposal, 'The configuration changed since this proposal; refresh and review it again.', await latestReceipt(deps, agentId, proposal.id))
    }

    const managed = await deps.config.managedNames(agentId)
    if (managed.includes(proposal.input.name)) {
        await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'pending')
        await deps.store.receipts.record(agentId, receipt(deps, proposal, decision.id, 'failed', currentRevision, 'This server name is managed by a connected app/service and cannot be replaced by a proposal.'))
        const requirement = 'This server name is managed by a connected app/service and cannot be replaced by a proposal.'
        return result('failed', await deps.store.get(agentId, proposal.id) ?? proposal, requirement, await latestReceipt(deps, agentId, proposal.id), [requirement])
    }

    const requirements = selfMcpRequirements(deps, owner, proposal)
    if (requirements.length) {
        await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'pending')
        await deps.store.receipts.record(agentId, receipt(deps, proposal, decision.id, 'failed', currentRevision, requirements.join(' ')))
        return result('failed', await deps.store.get(agentId, proposal.id) ?? proposal, requirements.join(' '), await latestReceipt(deps, agentId, proposal.id), requirements)
    }

    const server: SelfMcpServerCandidate = { ...proposal.input, transport: proposal.transport }

    // HTTP: probe-then-save with fresh authorization immediately before each action. A failed
    // probe saves nothing; the card returns to pending with the failure visible.
    if (proposal.transport === 'http') {
        const fresh = await deps.authority.currentOwner(agentId).catch(() => null)
        if (!fresh || !ownerOk(fresh)) {
            await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'cancelled')
            await deps.store.receipts.record(agentId, receipt(deps, proposal, decision.id, 'cancelled', currentRevision, 'The coworker was stopped while probing.'))
            return result('cancelled', await deps.store.get(agentId, proposal.id) ?? proposal, 'The coworker was stopped while probing.', await latestReceipt(deps, agentId, proposal.id))
        }
        const probe = await deps.probe.probe(agentId, server)
        if (probe.ok) {
            const applied = await applyServer(deps, agentId, server, request.expectedConfigRevision, decision.id, proposal)
            if (applied.kind !== 'saved') return appliedResult(applied, proposal)
            await deps.store.transition(agentId, proposal.id, applied.proposal.revision, 'claimed', 'applied')
            await deps.store.receipts.record(agentId, receipt(deps, applied.proposal, decision.id, 'applied', applied.configRevision, `Connected: ${probe.toolNames.length} tools probed.`))
            return result('applied', await deps.store.get(agentId, proposal.id) ?? applied.proposal, 'The server was saved and verified.', await latestReceipt(deps, agentId, proposal.id))
        }
        if (probe.needsCredentials || probe.needsPermission) {
            const applied = await applyServer(deps, agentId, server, request.expectedConfigRevision, decision.id, proposal)
            if (applied.kind !== 'saved') return appliedResult(applied, proposal)
            await deps.store.transition(agentId, proposal.id, applied.proposal.revision, 'claimed', 'applied')
            const detail = probe.needsCredentials
                ? 'The server was saved but rejected the credentials; connect with new credentials before its tools work.'
                : 'The server was saved but requires permission before its tools connect.'
            await deps.store.receipts.record(agentId, receipt(deps, applied.proposal, decision.id, probe.needsCredentials ? 'applied_pending_credentials' : 'applied', applied.configRevision, detail))
            return result(probe.needsCredentials ? 'applied_pending_credentials' : 'applied', await deps.store.get(agentId, proposal.id) ?? applied.proposal, detail, await latestReceipt(deps, agentId, proposal.id))
        }
        await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'pending')
        await deps.store.receipts.record(agentId, receipt(deps, proposal, decision.id, 'failed', currentRevision, `Could not connect: ${probe.error}`))
        return result('failed', await deps.store.get(agentId, proposal.id) ?? proposal, `Could not connect: ${probe.error}`, await latestReceipt(deps, agentId, proposal.id))
    }

    // stdio: save WITHOUT spawning or installing — nothing launches during preview/review/save.
    // sse: the separate capability (G) owns the transport; save without probing here.
    const applied = await applyServer(deps, agentId, server, request.expectedConfigRevision, decision.id, proposal)
    if (applied.kind !== 'saved') return appliedResult(applied, proposal)
    await deps.store.transition(agentId, proposal.id, applied.proposal.revision, 'claimed', 'applied')
    const detail = proposal.transport === 'stdio'
        ? 'Saved without launching the program; connectivity is unverified until a trusted probe runs.'
        : 'Saved; connectivity is provided by the separate SSE capability.'
    await deps.store.receipts.record(agentId, receipt(deps, applied.proposal, decision.id, 'applied_unverified', applied.configRevision, detail))
    return result('applied_unverified', await deps.store.get(agentId, proposal.id) ?? applied.proposal, detail, await latestReceipt(deps, agentId, proposal.id))
}

type ApplyOutcome =
    | { kind: 'saved'; proposal: SelfMcpProposal; configRevision: number }
    | { kind: 'cancelled'; proposal: SelfMcpProposal }
    | { kind: 'uncertain'; proposal: SelfMcpProposal }

async function applyServer(
    deps: SelfMcpDecisionDeps,
    agentId: string,
    server: SelfMcpServerCandidate,
    expectedRevision: number,
    decisionId: string,
    proposal: SelfMcpProposal,
): Promise<ApplyOutcome> {
    const fresh = await deps.authority.currentOwner(agentId).catch(() => null)
    if (!fresh || !ownerOk(fresh)) {
        await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'cancelled')
        await deps.store.receipts.record(agentId, receipt(deps, proposal, decisionId, 'cancelled', expectedRevision, 'The coworker was stopped before the server could be saved.'))
        return { kind: 'cancelled', proposal: await deps.store.get(agentId, proposal.id) ?? proposal }
    }
    try {
        const { configRevision } = await deps.config.apply(agentId, server, expectedRevision)
        return { kind: 'saved', proposal, configRevision }
    } catch {
        // The configuration moved underneath the save: mark uncertain rather than applying a
        // second registration; reconcile resolves it on the exact configuration revision.
        await deps.store.transition(agentId, proposal.id, proposal.revision, 'claimed', 'uncertain')
        await deps.store.receipts.record(agentId, receipt(deps, proposal, decisionId, 'failed', expectedRevision, 'The configuration changed during save; the result is uncertain. Refresh to recover.'))
        return { kind: 'uncertain', proposal: await deps.store.get(agentId, proposal.id) ?? proposal }
    }
}

function appliedResult(applied: Extract<ApplyOutcome, { kind: 'cancelled' | 'uncertain' }>, proposal: SelfMcpProposal): SelfMcpDecisionResult {
    if (applied.kind === 'cancelled') {
        return result('cancelled', applied.proposal, 'The coworker was stopped before the server could be saved.')
    }
    return result('failed', applied.proposal, 'The configuration changed during save; the result is uncertain. Refresh to recover.')
}
