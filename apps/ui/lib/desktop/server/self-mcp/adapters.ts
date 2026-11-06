import 'server-only'
import type { SelfMcpConnectivity, SelfMcpDecision, SelfMcpRunIdentity, SelfMcpServerInput, SelfMcpTransport } from '@rerun/contracts'

/**
 * Typed adapters the decision service consumes. Root implements them over the
 * existing desktop MCP configuration/transport stores and the mcp-binding
 * authority (fresh owner/grant checks, local-program grant, SSE capability);
 * this module never touches central schema, stores or lifecycle.
 */

export type SelfMcpServerCandidate = SelfMcpServerInput & { transport: SelfMcpTransport }

export type SelfMcpOwner = {
    agentId: string
    engineAgentId: string
    launchEpoch: string
    enabled: boolean
    deleting: boolean
    selfImprovementEnabled: boolean
    /** The default-off per-coworker self-MCP grant (root's authoritative reader). */
    selfMcpGranted: boolean
    /** The separate local-program execution grant required for stdio saves. */
    localMcpStdioGranted: boolean
    remoteMcpGranted: boolean
}

export interface SelfMcpAuthority {
    /** Current process/permission/Stop fence, independent of the persisted source epoch. */
    watch?(agentId: string, identity: SelfMcpRunIdentity): (() => void) | Promise<() => void>
    /** Resolves the local coworker for an engine agent id; throws when none exists. */
    ownerOfEngineId(engineAgentId: string): Promise<{ agentId: string }>
    /** Verifies exact local session/run/tool-call ownership, run Stop and launch epoch; a missing or replaced source returns null. */
    currentOwner(agentId: string, identity: SelfMcpRunIdentity, expectedLaunchEpoch?: string): Promise<SelfMcpOwner | null>
}

export type SelfMcpEffectContext = { signal: AbortSignal; assertCurrent: () => Promise<void>; assertCommit?: () => void }
export type SelfMcpApplyIdentity = { decision: SelfMcpDecision; launchEpoch: string }
export type SelfMcpApplyResult = { outcome: 'applied' | 'applied_pending_credentials' | 'applied_unverified'; detail: string }
export type SelfMcpApplyReceipt = SelfMcpApplyIdentity & SelfMcpApplyResult & { configRevision: number }
export type SelfMcpApplyRecovery = { state: 'applied'; receipt: SelfMcpApplyReceipt } | { state: 'not_applied' } | { state: 'uncertain' }

export interface SelfMcpConfigAdapter {
    requirements?(server: SelfMcpServerCandidate): string[]
    reviewRequirements?(owner: string, server: SelfMcpServerCandidate): Promise<string[]>
    /** Current trusted configuration revision (the CAS counter). */
    revision(agentId: string): Promise<number>
    /** Service-managed/protected server names that a model proposal can never replace. */
    managedNames(agentId: string): Promise<string[]>
    /** The exact configured server with this name, or null. */
    find(agentId: string, name: string): Promise<SelfMcpServerCandidate | null>
    /** Whether the trusted configuration already holds this exact server (same canonical input). */
    hasServer(agentId: string, server: SelfMcpServerCandidate): Promise<boolean>
    /**
     * Atomically upserts the server and seals this exact decision receipt,
     * using decision.configRevision as the CAS. Recheck context at commit;
     * an aborted or stale source must never commit a delayed write.
     */
    apply(agentId: string, server: SelfMcpServerCandidate, identity: SelfMcpApplyIdentity, context: SelfMcpEffectContext, result: SelfMcpApplyResult): Promise<SelfMcpApplyReceipt>
    /** Exact decision receipt, sealed atomically with the configuration CAS. Absence must never be inferred from current config equality. */
    recover(agentId: string, identity: SelfMcpApplyIdentity): Promise<SelfMcpApplyRecovery>
    /** Passive status for this exact config; reads never probe or launch programs. */
    connectivity(agentId: string, server: SelfMcpServerCandidate): Promise<SelfMcpConnectivity>
}

export type SelfMcpProbeResult =
    | { ok: true; toolNames: string[] }
    | { ok: false; needsCredentials: boolean; needsPermission: boolean; credentialsRejected: boolean; error: string }

export interface SelfMcpProbeAdapter {
    /** Transports this runtime can probe — and therefore enable. G owns sse. */
    transports: SelfMcpTransport[]
    /**
     * Fresh probe with fresh authorization. Must never spawn or install for a
     * local program: stdio saves happen without a probe (applied_unverified).
     * No probe happens at proposal time, only after a human approves.
     */
    probe(agentId: string, server: SelfMcpServerCandidate, context: SelfMcpEffectContext): Promise<SelfMcpProbeResult>
}
