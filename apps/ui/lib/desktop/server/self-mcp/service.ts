import 'server-only'
import { randomUUID } from 'node:crypto'
import {
    selfMcpInputIssue,
    selfMcpProposalInput,
    selfMcpResolvedTransport,
    type SelfMcpDecisionRequest,
    type SelfMcpDecisionResult,
    type SelfMcpProposal,
    type SelfMcpProposeResult,
    type SelfMcpReviewSnapshot,
    type SelfMcpRunIdentity,
} from '@rerun/contracts'
import { selfMcpFingerprint } from './fingerprint'
import type { SelfMcpAuthority, SelfMcpConfigAdapter, SelfMcpOwner, SelfMcpProbeAdapter } from './adapters'
import type { SelfMcpStore } from './store'
import { decideSelfMcpProposal, dismissSelfMcpProposal, reconcileSelfMcpProposals, selfMcpRequirements, type SelfMcpDecisionDeps } from './decision'

/**
 * The self-MCP review service: proposal admission, review snapshots and the
 * decision facade. It never opens a network connection and never changes
 * configuration at proposal time — those happen only inside the trusted
 * decision path, behind the injected authority/config/probe adapters.
 */

export type SelfMcpDependencies = {
    store: SelfMcpStore
    authority: SelfMcpAuthority
    config: SelfMcpConfigAdapter
    probe: SelfMcpProbeAdapter
}

export interface SelfMcpService {
    propose(request: { identity: SelfMcpRunIdentity; fingerprint: string; input: unknown }): Promise<SelfMcpProposeResult>
    list(agentId: string): Promise<SelfMcpProposal[]>
    review(agentId: string, proposalId: string): Promise<SelfMcpReviewSnapshot>
    decide(agentId: string, request: SelfMcpDecisionRequest): Promise<SelfMcpDecisionResult>
    dismiss(agentId: string, proposalId: string, expectedProposalRevision: number): Promise<SelfMcpDecisionResult>
}

const ownerAdmissible = (owner: SelfMcpOwner) => owner.enabled && !owner.deleting && owner.selfImprovementEnabled && owner.selfMcpGranted

export function createSelfMcpService(deps: SelfMcpDependencies): SelfMcpService {
    const decisionDeps: SelfMcpDecisionDeps = { ...deps, now: () => new Date().toISOString(), newId: () => randomUUID() }

    return {
        async propose(request) {
            // Strict nonsecret validation again at the service boundary (the engine validated
            // too): invalid proposals are refused before anything is reserved.
            const issue = selfMcpInputIssue(request.input)
            if (issue) return { outcome: 'refused', message: issue }
            const parsed = selfMcpProposalInput(request.input)
            if (!parsed) return { outcome: 'refused', message: 'Invalid MCP server proposal.' }

            const local = await deps.authority.ownerOfEngineId(request.identity.engineAgentId).catch(() => null)
            if (!local) return { outcome: 'refused', message: 'The coworker is unavailable.' }
            const owner = await deps.authority.currentOwner(local.agentId).catch(() => null)
            if (!owner || !ownerAdmissible(owner)) {
                return { outcome: 'refused', message: 'The coworker is disabled or the self-MCP permission is off.' }
            }

            const managed = await deps.config.managedNames(local.agentId)
            if (managed.includes(parsed.name)) {
                return { outcome: 'refused', message: 'This server name is managed by a connected app/service and cannot be replaced by a proposal.' }
            }

            // The fingerprint is recomputed here and must match the engine's: a tampered payload
            // never reaches the store.
            const computed = selfMcpFingerprint(parsed)
            if (computed !== request.fingerprint) return { outcome: 'refused', message: 'The proposal fingerprint does not match.' }

            const configRevision = await deps.config.revision(local.agentId)
            const reserved = await deps.store.reserve({
                id: randomUUID(),
                agentId: local.agentId,
                identity: request.identity,
                fingerprint: computed,
                input: parsed,
                transport: selfMcpResolvedTransport(parsed),
                configRevision,
                createdAt: new Date().toISOString(),
            })
            if (reserved.outcome === 'conflict') {
                return { outcome: 'conflict', message: 'A different proposal from this call already exists and cannot be replaced.' }
            }
            if (reserved.outcome === 'reconciled') {
                return { outcome: 'reconciled', message: 'An identical proposal from this call is already under review.', proposal: reserved.proposal }
            }
            return { outcome: 'proposed', message: 'Proposal created and waiting for review.', proposal: reserved.proposal }
        },

        async list(agentId) {
            await reconcileSelfMcpProposals(decisionDeps, agentId)
            return deps.store.list(agentId)
        },

        async review(agentId, proposalId) {
            await reconcileSelfMcpProposals(decisionDeps, agentId)
            const proposal = await deps.store.get(agentId, proposalId)
            if (!proposal) throw new Error('Proposal not found')
            const [owner, configRevision, managed] = await Promise.all([
                deps.authority.currentOwner(agentId).catch(() => null),
                deps.config.revision(agentId),
                deps.config.managedNames(agentId),
            ])
            const server = { ...proposal.input, transport: proposal.transport }
            const [alreadyConfigured, existing] = await Promise.all([
                deps.config.hasServer(agentId, server),
                deps.config.find(agentId, proposal.input.name),
            ])
            const requirements = owner ? selfMcpRequirements(decisionDeps, owner, proposal) : ['The coworker is unavailable for review.']
            const snapshot: SelfMcpReviewSnapshot = {
                proposal,
                configRevision,
                connectivity: alreadyConfigured ? 'connected' : 'unverified',
                requirements,
                conflict: { existing: !!existing, managed: managed.includes(proposal.input.name), ...(existing ? { replaces: existing.name } : {}) },
                alreadyConfigured,
            }
            return snapshot
        },

        async decide(agentId, request) {
            return decideSelfMcpProposal(decisionDeps, agentId, request)
        },

        async dismiss(agentId, proposalId, expectedProposalRevision) {
            return dismissSelfMcpProposal(decisionDeps, agentId, proposalId, expectedProposalRevision)
        },
    }
}

const SERVICE_SLOT = Symbol.for('rerun.desktop.self-mcp.service.v1')

/** Root binds the service over its central store and the mcp-binding authority at startup. */
export function bindDesktopSelfMcp(deps: SelfMcpDependencies): void {
    ;(globalThis as Record<symbol, unknown>)[SERVICE_SLOT] = createSelfMcpService(deps)
}

export function getDesktopSelfMcpService(): SelfMcpService {
    const service = (globalThis as Record<symbol, unknown>)[SERVICE_SLOT]
    if (!service) throw new Error('The self-MCP review service is not bound')
    return service as SelfMcpService
}
