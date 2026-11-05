import 'server-only'
import type { SelfMcpServerInput, SelfMcpTransport } from '@rerun/contracts'

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
    enabled: boolean
    deleting: boolean
    selfImprovementEnabled: boolean
    /** The default-off per-coworker self-MCP grant (root's authoritative reader). */
    selfMcpGranted: boolean
    /** The separate local-program execution grant required for stdio saves. */
    localMcpStdioGranted: boolean
}

export interface SelfMcpAuthority {
    /** Resolves the local coworker for an engine agent id; throws when none exists. */
    ownerOfEngineId(engineAgentId: string): Promise<{ agentId: string }>
    /** Fresh owner snapshot; null when the owner is stopped/deleted — a late decision can never resurrect it. */
    currentOwner(agentId: string): Promise<SelfMcpOwner | null>
}

export interface SelfMcpConfigAdapter {
    /** Current trusted configuration revision (the CAS counter). */
    revision(agentId: string): Promise<number>
    /** Service-managed/protected server names that a model proposal can never replace. */
    managedNames(agentId: string): Promise<string[]>
    /** The exact configured server with this name, or null. */
    find(agentId: string, name: string): Promise<SelfMcpServerCandidate | null>
    /** Whether the trusted configuration already holds this exact server (same canonical input). */
    hasServer(agentId: string, server: SelfMcpServerCandidate): Promise<boolean>
    /**
     * Upserts the server into the trusted configuration and returns the new
     * revision. Must CAS on `expectedRevision`: when the configuration moved
     * underneath, it throws instead of applying a second registration.
     */
    apply(agentId: string, server: SelfMcpServerCandidate, expectedRevision: number): Promise<{ configRevision: number }>
}

export type SelfMcpProbeResult =
    | { ok: true; toolNames: string[] }
    | { ok: false; needsCredentials: boolean; needsPermission: boolean; error: string }

export interface SelfMcpProbeAdapter {
    /** Transports this runtime can probe — and therefore enable. G owns sse. */
    transports: SelfMcpTransport[]
    /**
     * Fresh probe with fresh authorization. Must never spawn or install for a
     * local program: stdio saves happen without a probe (applied_unverified).
     * No probe happens at proposal time, only after a human approves.
     */
    probe(agentId: string, server: SelfMcpServerCandidate): Promise<SelfMcpProbeResult>
}
