import { createHash } from 'node:crypto'
import { selfMcpCanonicalInput, type SelfMcpRunIdentity, type SelfMcpServerInput, type SelfMcpTransport } from '@rerun/contracts'
import type { SelfMcpAuthority, SelfMcpConfigAdapter, SelfMcpOwner, SelfMcpProbeAdapter, SelfMcpServerCandidate } from './adapters'
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
    enabled: true,
    deleting: false,
    selfImprovementEnabled: true,
    selfMcpGranted: true,
    localMcpStdioGranted: false,
    ...overrides,
})

export type FakeAuthority = SelfMcpAuthority & { calls: { method: string; agentId?: string }[] }
export function makeAuthority(options: { owner?: Partial<SelfMcpOwner>; currentOwner?: (agentId: string) => Promise<SelfMcpOwner | null>; ownerOfEngineId?: (engineAgentId: string) => Promise<{ agentId: string }> } = {}): FakeAuthority {
    const calls: { method: string; agentId?: string }[] = []
    return {
        calls,
        async ownerOfEngineId(engineAgentId) {
            calls.push({ method: 'ownerOfEngineId', agentId: engineAgentId })
            if (options.ownerOfEngineId) return options.ownerOfEngineId(engineAgentId)
            return { agentId: 'local-1' }
        },
        async currentOwner(agentId) {
            calls.push({ method: 'currentOwner', agentId })
            // A custom reader may return null to simulate a stopped owner; it must propagate.
            if (options.currentOwner) return options.currentOwner(agentId)
            return owner(options.owner)
        },
    }
}

export type ProbeResult = Awaited<ReturnType<SelfMcpProbeAdapter['probe']>>

export type FakeConfig = SelfMcpConfigAdapter & {
    calls: string[]
    revisionValue: number
    setRevision(revision: number): void
    seed(server: SelfMcpServerCandidate): void
}
export function makeConfig(options: { revision?: number; managed?: string[]; servers?: SelfMcpServerCandidate[]; applyError?: string } = {}): FakeConfig {
    let revision = options.revision ?? 3
    const servers = new Map<string, SelfMcpServerCandidate>()
    for (const server of options.servers ?? []) servers.set(server.name, server)
    const calls: string[] = []
    return {
        calls,
        revisionValue: revision,
        setRevision(value) { revision = value; this.revisionValue = value },
        seed(server) { servers.set(server.name, server) },
        async revision() { calls.push('revision'); return revision },
        async managedNames() { calls.push('managedNames'); return options.managed ?? [] },
        async find(_agentId, name) { calls.push('find'); return servers.get(name) ?? null },
        async hasServer(_agentId, server) {
            calls.push('hasServer')
            const found = servers.get(server.name)
            return !!found && selfMcpCanonicalInput(found) === selfMcpCanonicalInput(server)
        },
        async apply(_agentId, server, expectedRevision) {
            calls.push('apply')
            if (options.applyError !== undefined) throw new Error(options.applyError)
            if (revision !== expectedRevision) throw new Error('Configuration revision moved')
            servers.set(server.name, server)
            revision += 1
            this.revisionValue = revision
            return { configRevision: revision }
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
        identity: identity(),
        fingerprint: fingerprintOf(validInput()),
        input: validInput(),
        transport: 'http',
        configRevision: 3,
        createdAt: NOW,
        ...overrides,
    })
}
