import { describe, expect, it } from 'vitest'
import { validInput, fingerprintOf, identity, makeAuthority, makeConfig, makeProbe, seedProposal, owner } from './test-support'
import { createSelfMcpMemoryStore } from './store'
import { createSelfMcpService } from './service'

const serviceOf = (overrides: { authority?: ReturnType<typeof makeAuthority>; config?: ReturnType<typeof makeConfig>; probe?: ReturnType<typeof makeProbe> } = {}) => {
    const store = createSelfMcpMemoryStore()
    const authority = overrides.authority ?? makeAuthority()
    const config = overrides.config ?? makeConfig()
    const probe = overrides.probe ?? makeProbe()
    return { store, authority, config, probe, service: createSelfMcpService({ store, authority, config, probe }) }
}

describe('self-mcp service — propose', () => {
    it('reserves a pending proposal for a granted, non-deleting owner', async () => {
        const { store, service } = serviceOf()
        const result = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect(result.outcome).toBe('proposed')
        const rows = await store.list('local-1')
        expect(rows).toHaveLength(1)
        expect(rows[0].status).toBe('pending')
        expect(rows[0].agentId).toBe('local-1')
        expect(rows[0].transport).toBe('http')
        expect(rows[0].configRevision).toBe(3)
        expect(rows[0].identity).toEqual(identity())
        expect(rows[0].fingerprint).toBe(fingerprintOf(validInput()))
    })

    it('resolves the local owner from the engine identity', async () => {
        const authority = makeAuthority({ ownerOfEngineId: async () => ({ agentId: 'local-9' }) })
        const { store, service } = serviceOf({ authority })
        await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect((await store.list('local-9'))).toHaveLength(1)
    })

    it.each([
        ['disabled', { enabled: false }],
        ['being deleted', { deleting: true }],
        ['Improve-itself master off', { selfImprovementEnabled: false }],
        ['self-MCP grant off', { selfMcpGranted: false }],
    ] as const)('refuses a proposal when the owner is %s, before reserving anything', async (_label, ownerOverrides) => {
        const { store, service, config } = serviceOf({ authority: makeAuthority({ owner: owner(ownerOverrides) }) })
        const result = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect(result.outcome).toBe('refused')
        expect(result.message).toContain('disabled or the self-MCP permission is off')
        expect(await store.list('local-1')).toHaveLength(0)
        expect(config.calls).not.toContain('apply')
    })

    it('refuses when the engine identity maps to no local owner', async () => {
        const { store, service } = serviceOf({ authority: makeAuthority({ ownerOfEngineId: async () => { throw new Error('gone') } }) })
        const result = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect(result.outcome).toBe('refused')
        expect(await store.list('local-1')).toHaveLength(0)
    })

    it('refuses a name that a connected app/service manages', async () => {
        const { store, service } = serviceOf({ config: makeConfig({ managed: ['linear'] }) })
        const result = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect(result.outcome).toBe('refused')
        expect(result.message).toContain('managed by a connected app/service')
        expect(await store.list('local-1')).toHaveLength(0)
    })

    it('refuses a tampered payload whose fingerprint does not match', async () => {
        const { store, service } = serviceOf()
        const result = await service.propose({ identity: identity(), fingerprint: 'f'.repeat(64), input: validInput() })
        expect(result.outcome).toBe('refused')
        expect(result.message).toContain('fingerprint does not match')
        expect(await store.list('local-1')).toHaveLength(0)
    })

    it('refuses invalid input (inline secret) before any reservation, read or probe', async () => {
        const { store, service, config, probe } = serviceOf()
        const result = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput({ headers: { Authorization: 'sk-live-secret' } }) })
        expect(result.outcome).toBe('refused')
        expect(await store.list('local-1')).toHaveLength(0)
        expect(config.calls).not.toContain('apply')
        expect(config.calls).not.toContain('revision')
        expect(probe.calls).toHaveLength(0)
    })

    it('reconciles the identical invocation into one proposal and conflicts on a changed body', async () => {
        const { store, service } = serviceOf()
        const first = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect(first.outcome).toBe('proposed')
        const same = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect(same.outcome).toBe('reconciled')
        expect(await store.list('local-1')).toHaveLength(1)
        const changed = await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput({ url: 'https://other.example' })), input: validInput({ url: 'https://other.example' }) })
        expect(changed.outcome).toBe('conflict')
        expect(await store.list('local-1')).toHaveLength(1)
    })

    it('auto-detects stdio from a command and keeps the resolved transport on the proposal', async () => {
        const { store, service } = serviceOf({ probe: makeProbe({ transports: ['http', 'stdio'] }) })
        const input = validInput({ transport: undefined, command: 'npx', url: undefined, args: ['-y', '@modelcontextprotocol/server-filesystem'], headers: {} })
        const result = await service.propose({ identity: identity(), fingerprint: fingerprintOf(input), input })
        expect(result.outcome).toBe('proposed')
        expect((await store.list('local-1'))[0].transport).toBe('stdio')
    })

    it('proposing never probes or mutates configuration', async () => {
        const { service, config, probe, store } = serviceOf()
        await service.propose({ identity: identity(), fingerprint: fingerprintOf(validInput()), input: validInput() })
        expect(probe.calls).toHaveLength(0)
        expect(config.calls).not.toContain('apply')
        const rows = await store.list('local-1')
        expect(rows).toHaveLength(1)
        expect(rows[0].status).toBe('pending')
    })
})

describe('self-mcp service — list and review', () => {
    it('lists proposals and recovers uncertain proposals without auto-approval', async () => {
        const { store, service, config } = serviceOf()
        await seedProposal(store)
        const seeded = await seedProposal(store, { id: 'prop-2', identity: identity({ toolCallId: 'call-2' }), fingerprint: fingerprintOf(validInput({ name: 'notion' })), input: validInput({ name: 'notion' }), transport: 'http' })
        if (seeded.outcome !== 'created') throw new Error('seed failed')
        // A save that hit a moved configuration leaves an uncertain row; list recovers it.
        await store.transition('local-1', 'prop-2', 1, 'pending', 'uncertain')
        const rows = await service.list('local-1')
        // Nothing applied and the configuration never moved: released back to pending.
        expect(rows.find(row => row.id === 'prop-2')?.status).toBe('pending')
        expect(config.calls).not.toContain('apply')
    })

    it('leaves a live claimed row alone on list — that is an in-flight decision', async () => {
        const { store, service } = serviceOf()
        await seedProposal(store)
        await store.claim('local-1', 'prop-1', 1)
        const rows = await service.list('local-1')
        expect(rows[0].status).toBe('claimed')
    })

    it('reviews a pending http proposal with an unverified connection', async () => {
        const { store, service } = serviceOf()
        await seedProposal(store)
        const snapshot = await service.review('local-1', 'prop-1')
        expect(snapshot.proposal.status).toBe('pending')
        expect(snapshot.connectivity).toBe('unverified')
        expect(snapshot.alreadyConfigured).toBe(false)
        expect(snapshot.conflict).toEqual({ existing: false, managed: false })
        expect(snapshot.configRevision).toBe(3)
    })

    it('reports an already-configured server as connected and a replacement conflict', async () => {
        const config = makeConfig({ servers: [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app', command: undefined, args: [], env: {}, headers: {} }] })
        const { store, service } = serviceOf({ config })
        await seedProposal(store)
        const snapshot = await service.review('local-1', 'prop-1')
        expect(snapshot.alreadyConfigured).toBe(false)
        expect(snapshot.connectivity).toBe('unverified')
        expect(snapshot.conflict?.existing).toBe(true)
        expect(snapshot.conflict?.replaces).toBe('linear')
        // When the configured server matches the proposal exactly, it is the same server.
        const { store: matchingStore, service: matchingService } = serviceOf({ config: makeConfig({ servers: [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app', command: undefined, args: [], env: {}, headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' } }] }) })
        await seedProposal(matchingStore)
        const matching = await matchingService.review('local-1', 'prop-1')
        expect(matching.alreadyConfigured).toBe(true)
        expect(matching.connectivity).toBe('connected')
    })

    it('surfaces transport requirements on the snapshot (sse capability and stdio grant)', async () => {
        const probe = makeProbe({ transports: ['http'] })
        const { store, service } = serviceOf({ probe })
        await seedProposal(store, { id: 'sse-1', identity: identity({ toolCallId: 'sse' }), fingerprint: fingerprintOf(validInput({ name: 'stream', transport: 'sse' })), input: validInput({ name: 'stream', transport: 'sse' }), transport: 'sse' })
        const sse = await service.review('local-1', 'sse-1')
        expect(sse.requirements.some(text => text.includes('SSE transport'))).toBe(true)
        await seedProposal(store, { id: 'stdio-1', identity: identity({ toolCallId: 'stdio' }), fingerprint: fingerprintOf(validInput({ name: 'local', transport: 'stdio', command: 'npx', url: undefined, env: { API_KEY: '${K}' } })), input: validInput({ name: 'local', transport: 'stdio', command: 'npx', url: undefined, env: { API_KEY: '${K}' } }), transport: 'stdio' })
        const stdio = await service.review('local-1', 'stdio-1')
        expect(stdio.requirements.some(text => text.includes('Local MCP programs permission'))).toBe(true)
    })

    it('throws when the proposal does not exist', async () => {
        const { service } = serviceOf()
        await expect(service.review('local-1', 'missing')).rejects.toThrow('Proposal not found')
    })
})
