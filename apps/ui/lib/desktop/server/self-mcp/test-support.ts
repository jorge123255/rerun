import { createHash } from 'node:crypto'
import { selfMcpCanonicalInput, type SelfMcpDecision, type SelfMcpRunIdentity, type SelfMcpServerInput, type SelfMcpTransport } from '@rerun/contracts'
import type { SelfMcpApplyReceipt, SelfMcpAuthority, SelfMcpConfigAdapter, SelfMcpOwner, SelfMcpProbeAdapter, SelfMcpServerCandidate } from './adapters'
import { createSelfMcpMemoryStore, type SelfMcpStore } from './store'

export const NOW = '2026-11-05T00:00:00.000Z'

export const identity = (overrides: Partial<SelfMcpRunIdentity> = {}): SelfMcpRunIdentity => ({
    engineAgentId: 'engine-1',
    sessionId: 'session-1',
    runId: 'run-1',
    toolCallId: 'call-1',
    ...overrides,
})

export const validInput = (overrides: Partial<SelfMcpServerInput> = {}): SelfMcpServerInput => ({
    name: 'linear',
    transport: 'http',
    command: undefined,
    args: [],
    url: 'https://mcp.linear.app',
    env: {},
    headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
    ...overrides,
})

export const fingerprintOf = (input: SelfMcpServerInput) => createHash('sha256').update(selfMcpCanonicalInput(input)).digest('hex')

export const owner = (overrides: Partial<SelfMcpOwner> = {}): SelfMcpOwner => ({
    agentId: 'local-1',
    engineAgentId: 'engine-1',
    launchEpoch: 'epoch-1',
    enabled: true,
    deleting: false,
    selfImprovementEnabled: true,
    selfMcpGranted: true,
    localMcpStdioGranted: false,
    remoteMcpGranted: true,
    ...overrides,
})

export type FakeAuthority = SelfMcpAuthority & { calls: { method: string; agentId?: string }[] }
export function makeAuthority(options: { owner?: Partial<SelfMcpOwner>; currentOwner?: SelfMcpAuthority['currentOwner']; ownerOfEngineId?: (engineAgentId: string) => Promise<{ agentId: string }> } = {}): FakeAuthority {
    const calls: { method: string; agentId?: string }[] = []
    return {
        calls,
        async ownerOfEngineId(engineAgentId) {
            calls.push({ method: 'ownerOfEngineId', agentId: engineAgentId })
            if (options.ownerOfEngineId) return options.ownerOfEngineId(engineAgentId)
            return { agentId: 'local-1' }
        },
        async currentOwner(agentId, source, expectedEpoch) {
            calls.push({ method: 'currentOwner', agentId })
            // A custom reader may return null to simulate a stopped owner; it must propagate.
            if (options.currentOwner) return options.currentOwner(agentId, source, expectedEpoch)
            return owner({ agentId, ...options.owner })
        },
    }
}

export type ProbeResult = Awaited<ReturnType<SelfMcpProbeAdapter['probe']>>

export const decisionFor = (overrides: Partial<SelfMcpDecision> = {}): SelfMcpDecision => ({
    id: 'dec-1', proposalId: 'prop-1', proposalRevision: 1, configRevision: 3,
    identity: identity(), fingerprint: fingerprintOf(validInput()), outcome: { kind: 'approved' }, agentId: 'local-1', decidedAt: NOW,
    ...overrides,
})

export type FakeConfig = SelfMcpConfigAdapter & {
    calls: string[]
    revisionValue: number
    setRevision(revision: number): void
    seed(server: SelfMcpServerCandidate): void
    seedReceipt(receipt: SelfMcpApplyReceipt): void
}
export function makeConfig(options: { revision?: number; managed?: string[]; servers?: SelfMcpServerCandidate[]; applyError?: string } = {}): FakeConfig {
    let revision = options.revision ?? 3
    const servers = new Map<string, SelfMcpServerCandidate>()
    for (const server of options.servers ?? []) servers.set(server.name, server)
    const calls: string[] = []
    const applied = new Map<string, SelfMcpApplyReceipt>()
    return {
        calls,
        revisionValue: revision,
        setRevision(value) { revision = value; this.revisionValue = value },
        seed(server) { servers.set(server.name, server) },
        seedReceipt(receipt) { applied.set(`${receipt.decision.agentId}:${receipt.decision.id}`, receipt) },
        async revision() { calls.push('revision'); return revision },
        async managedNames() { calls.push('managedNames'); return options.managed ?? [] },
        async find(_agentId, name) { calls.push('find'); return servers.get(name) ?? null },
        async hasServer(_agentId, server) {
            calls.push('hasServer')
            const found = servers.get(server.name)
            return !!found && selfMcpCanonicalInput(found) === selfMcpCanonicalInput(server)
        },
        async connectivity() { return 'unverified' },
        async recover(agentId, identity) {
            const receipt = applied.get(`${agentId}:${identity.decision.id}`)
            return receipt ? { state: 'applied', receipt } : { state: 'not_applied' }
        },
        async apply(agentId, server, identity, context, result) {
            calls.push('apply')
            if (options.applyError !== undefined) throw new Error(options.applyError)
            await context.assertCurrent()
            context.signal.throwIfAborted()
            if (revision !== identity.decision.configRevision) throw new Error('Configuration revision moved')
            servers.set(server.name, server)
            revision += 1
            this.revisionValue = revision
            const receipt = { ...identity, ...result, configRevision: revision }
            applied.set(`${agentId}:${identity.decision.id}`, receipt)
            return receipt
        },
    }
}

export type FakeProbe = SelfMcpProbeAdapter & { calls: string[]; setResult(result: ProbeResult): void }
export function makeProbe(options: { transports?: SelfMcpTransport[]; result?: ProbeResult } = {}): FakeProbe {
    const calls: string[] = []
    let result = options.result ?? { ok: true, toolNames: ['linear_tool'] }
    return {
        calls,
        transports: options.transports ?? ['http'],
        setResult(next) { result = next },
        async probe() { calls.push('probe'); return result },
    }
}

export async function seedProposal(store: SelfMcpStore, overrides: Partial<Parameters<SelfMcpStore['reserve']>[0]> = {}): ReturnType<SelfMcpStore['reserve']> {
    return store.reserve({
        id: 'prop-1',
        agentId: 'local-1',
        launchEpoch: 'epoch-1',
        identity: identity(),
        fingerprint: fingerprintOf(validInput()),
        input: validInput(),
        transport: 'http',
        configRevision: 3,
        createdAt: NOW,
        ...overrides,
    })
}
