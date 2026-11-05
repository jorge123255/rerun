import { describe, expect, it } from 'vitest'
import { NOW, validInput, fingerprintOf, identity, makeAuthority, makeConfig, makeProbe, seedProposal, owner } from './test-support'
import { createSelfMcpMemoryStore } from './store'
import { decideSelfMcpProposal, dismissSelfMcpProposal, reconcileSelfMcpProposal, SelfMcpProposalNotFoundError, SelfMcpStaleProposalError, type SelfMcpDecisionDeps } from './decision'

const make = (overrides: { authority?: ReturnType<typeof makeAuthority>; config?: ReturnType<typeof makeConfig>; probe?: ReturnType<typeof makeProbe> } = {}) => {
    const store = createSelfMcpMemoryStore()
    const authority = overrides.authority ?? makeAuthority()
    const config = overrides.config ?? makeConfig()
    const probe = overrides.probe ?? makeProbe()
    let seq = 0
    const deps: SelfMcpDecisionDeps = { store, authority, config, probe, now: () => NOW, newId: () => `id-${++seq}` }
    return { store, authority, config, probe, deps }
}

const approve = (overrides: Record<string, unknown> = {}) => ({
    proposalId: 'prop-1',
    decisionId: 'dec-1',
    expectedProposalRevision: 1,
    expectedConfigRevision: 3,
    outcome: { kind: 'approved' },
    ...overrides,
})

const reject = (overrides: Record<string, unknown> = {}) => ({
    ...approve({ decisionId: 'dec-r' }),
    outcome: { kind: 'rejected', reason: 'Not needed.' },
    ...overrides,
})

const stdioInput = () => validInput({ name: 'local-tool', transport: 'stdio', command: 'npx', url: undefined, env: { API_KEY: '${K}' }, headers: {} })

describe('approve — probe then save, with fresh authorization', () => {
    it('approves an http server: fresh probe, CAS save, durable applied receipt', async () => {
        const { deps, store, config, probe, authority } = make()
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('applied')
        expect(result.message).toContain('saved and verified')
        expect(probe.calls).toEqual(['probe'])
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(1)
        expect(config.revisionValue).toBe(4)
        const proposal = await store.get('local-1', 'prop-1')
        expect(proposal?.status).toBe('applied')
        const receipt = (await store.receipts.byProposal('local-1', 'prop-1')).at(-1)
        expect(receipt?.outcome).toBe('applied')
        expect(receipt?.configRevision).toBe(4)
        // Fresh authorization immediately before each action: admission + pre-probe.
        expect(authority.calls.filter(call => call.method === 'currentOwner')).toHaveLength(2)
    })

    it('records applied_pending_credentials when the server rejects the credentials', async () => {
        const probe = makeProbe({ result: { ok: false, needsCredentials: true, needsPermission: false, error: '401 Unauthorized' } })
        const { deps, store, config } = make({ probe })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('applied_pending_credentials')
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(1)
        expect((await store.receipts.byProposal('local-1', 'prop-1')).at(-1)?.outcome).toBe('applied_pending_credentials')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('applied')
    })

    it('a failed probe saves nothing and returns the card to pending', async () => {
        const probe = makeProbe({ result: { ok: false, needsCredentials: false, needsPermission: false, error: 'ECONNREFUSED' } })
        const { deps, store, config } = make({ probe })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('failed')
        expect(result.message).toContain('ECONNREFUSED')
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('pending')
        expect((await store.receipts.byProposal('local-1', 'prop-1')).at(-1)?.outcome).toBe('failed')
    })

    it('cannot enable an unsupported transport: visible requirement, nothing probed or saved', async () => {
        const probe = makeProbe({ transports: [] })
        const { deps, store, config } = make({ probe })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('failed')
        expect(result.requirements.some(text => text.includes('HTTP probing'))).toBe(true)
        expect(probe.calls).toHaveLength(0)
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('pending')
    })

    it('a probe that needs permission saves but never claims the tools work', async () => {
        const probe = makeProbe({ result: { ok: false, needsCredentials: false, needsPermission: true, error: 'permission required' } })
        const { deps, store, config } = make({ probe })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('applied')
        expect(result.message).toContain('requires permission')
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(1)
    })
})

describe('approve — sse and stdio requirements, never spawning or installing', () => {
    it('sse without the separate capability is a visible requirement that cannot be enabled', async () => {
        const probe = makeProbe({ transports: ['http'] })
        const { deps, store, config } = make({ probe })
        await seedProposal(store, { id: 'sse-1', identity: identity({ toolCallId: 'sse' }), fingerprint: fingerprintOf(validInput({ name: 'stream', transport: 'sse' })), input: validInput({ name: 'stream', transport: 'sse' }), transport: 'sse' })
        const result = await decideSelfMcpProposal(deps, 'local-1', approve({ proposalId: 'sse-1' }))
        expect(result.outcome).toBe('failed')
        expect(result.requirements.some(text => text.includes('SSE transport'))).toBe(true)
        expect(probe.calls).toHaveLength(0)
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'sse-1'))?.status).toBe('pending')
    })

    it('sse with the capability saves without probing here', async () => {
        const probe = makeProbe({ transports: ['http', 'sse'] })
        const { deps, store, config } = make({ probe })
        await seedProposal(store, { id: 'sse-1', identity: identity({ toolCallId: 'sse' }), fingerprint: fingerprintOf(validInput({ name: 'stream', transport: 'sse' })), input: validInput({ name: 'stream', transport: 'sse' }), transport: 'sse' })
        const result = await decideSelfMcpProposal(deps, 'local-1', approve({ proposalId: 'sse-1' }))
        expect(result.outcome).toBe('applied_unverified')
        expect(probe.calls).toHaveLength(0)
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(1)
    })

    it('stdio without the separate local-program grant is a visible requirement; nothing spawns', async () => {
        const { deps, store, config, probe } = make({ probe: makeProbe({ transports: ['http', 'stdio'] }) })
        await seedProposal(store, { id: 'stdio-1', identity: identity({ toolCallId: 'stdio' }), fingerprint: fingerprintOf(stdioInput()), input: stdioInput(), transport: 'stdio' })
        const result = await decideSelfMcpProposal(deps, 'local-1', approve({ proposalId: 'stdio-1' }))
        expect(result.outcome).toBe('failed')
        expect(result.requirements.some(text => text.includes('Local MCP programs permission'))).toBe(true)
        expect(probe.calls).toHaveLength(0)
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'stdio-1'))?.status).toBe('pending')
    })

    it('stdio with the grant saves without spawning, installing or probing', async () => {
        const authority = makeAuthority({ owner: owner({ localMcpStdioGranted: true }) })
        const { deps, store, config, probe } = make({ authority, probe: makeProbe({ transports: ['http', 'stdio'] }) })
        await seedProposal(store, { id: 'stdio-1', identity: identity({ toolCallId: 'stdio' }), fingerprint: fingerprintOf(stdioInput()), input: stdioInput(), transport: 'stdio' })
        const result = await decideSelfMcpProposal(deps, 'local-1', approve({ proposalId: 'stdio-1' }))
        expect(result.outcome).toBe('applied_unverified')
        expect(result.message).toContain('without launching the program')
        expect(probe.calls).toHaveLength(0)
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(1)
        expect((await store.get('local-1', 'stdio-1'))?.status).toBe('applied')
        expect((await store.receipts.byProposal('local-1', 'stdio-1')).at(-1)?.outcome).toBe('applied_unverified')
    })
})

describe('reject — a rejection never touches configuration', () => {
    it('records a rejected receipt and leaves unrelated configured servers intact', async () => {
        const config = makeConfig({ servers: [{ name: 'github', transport: 'http', url: 'https://api.github.com/mcp', command: undefined, args: [], env: {}, headers: {} }] })
        const { deps, store } = make({ config })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', reject())
        expect(result.outcome).toBe('rejected')
        expect(result.message).toContain('nothing was saved')
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('rejected')
        expect((await store.receipts.byProposal('local-1', 'prop-1')).at(-1)?.outcome).toBe('rejected')
        expect(await config.find('local-1', 'github')).not.toBeNull()
        expect(await config.find('local-1', 'linear')).toBeNull()
    })
})

describe('duplicate and racing decisions converge to one result', () => {
    it('the same decision id retried converges without a second save', async () => {
        const { deps, store, config } = make()
        await seedProposal(store)
        const first = await decideSelfMcpProposal(deps, 'local-1', approve())
        const again = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(first.outcome).toBe('applied')
        expect(again.outcome).toBe('applied')
        expect(again.receipt?.id).toBe(first.receipt?.id)
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(1)
    })

    it('a second tab racing an in-flight claim sees in_flight, then converges once the first settles', async () => {
        const { deps, store, config } = make()
        await seedProposal(store)
        const claim = await store.claim('local-1', 'prop-1', 1)
        if (claim.result !== 'transitioned') throw new Error('claim failed')
        const racing = await decideSelfMcpProposal(deps, 'local-1', approve({ decisionId: 'dec-2' }))
        expect(racing.outcome).toBe('in_flight')
        // The first tab settles: applied with a durable receipt.
        const settled = await store.transition('local-1', 'prop-1', claim.proposal.revision, 'claimed', 'applied')
        if (settled.result !== 'transitioned') throw new Error('settle failed')
        await store.receipts.record('local-1', { id: 'rc-1', proposalId: 'prop-1', decisionId: 'dec-1', outcome: 'applied', configRevision: 4, createdAt: NOW })
        const retry = await decideSelfMcpProposal(deps, 'local-1', approve({ decisionId: 'dec-2' }))
        expect(retry.outcome).toBe('applied')
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(0)
    })

    it('a late decision cannot resurrect a cancelled run or a deleted owner', async () => {
        const authority = makeAuthority({ owner: owner({ deleting: true }) })
        const { deps, store, config } = make({ authority })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('cancelled')
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('cancelled')
        expect((await store.receipts.byProposal('local-1', 'prop-1')).at(-1)?.outcome).toBe('cancelled')
    })

    it('a decision stale on the proposal revision is refused', async () => {
        const { deps, store, config } = make()
        await seedProposal(store)
        await expect(decideSelfMcpProposal(deps, 'local-1', approve({ expectedProposalRevision: 99 }))).rejects.toThrow(SelfMcpStaleProposalError)
        expect(config.calls).not.toContain('apply')
    })

    it('a decision stale on the configuration revision refuses instead of applying a second registration', async () => {
        const { deps, store, config } = make()
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve({ expectedConfigRevision: 5 }))
        expect(result.outcome).toBe('failed')
        expect(result.message).toContain('configuration changed')
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('pending')
    })

    it('approving a managed server name is a visible requirement and saves nothing', async () => {
        const config = makeConfig({ managed: ['linear'] })
        const { deps, store } = make({ config })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('failed')
        expect(result.requirements.some(text => text.includes('managed'))).toBe(true)
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('pending')
    })
})

describe('Stop/restart races and lost acknowledgements', () => {
    it('Stop between admission and the probe cancels without probing or saving', async () => {
        let calls = 0
        const authority = makeAuthority({ currentOwner: async () => {
            calls += 1
            return calls === 1 ? owner() : null
        } })
        const { deps, store, config, probe } = make({ authority })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('cancelled')
        expect(probe.calls).toHaveLength(0)
        expect(config.calls).not.toContain('apply')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('cancelled')
    })

    it('a config change mid-save marks the outcome uncertain and reconcile recovers without auto-applying', async () => {
        const config = makeConfig({ revision: 3, applyError: 'Configuration revision moved' })
        const { deps, store } = make({ config })
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('failed')
        expect(result.message).toContain('uncertain')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('uncertain')
        const recovered = await reconcileSelfMcpProposal(deps, 'local-1', await store.get('local-1', 'prop-1')!)
        expect(recovered.status).toBe('pending')
        expect(config.calls.filter(call => call === 'apply')).toHaveLength(1)
    })

    it('lost acknowledgement: the exact server already in configuration is durably acknowledged on restart', async () => {
        const config = makeConfig({ revision: 4, servers: [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app', command: undefined, args: [], env: {}, headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' } }] })
        const { deps, store } = make({ config })
        await seedProposal(store)
        const claim = await store.claim('local-1', 'prop-1', 1)
        if (claim.result !== 'transitioned') throw new Error('claim failed')
        await store.decisions.record('local-1', { id: 'dec-1', proposalId: 'prop-1', proposalRevision: 2, configRevision: 3, identity: identity(), fingerprint: fingerprintOf(validInput()), outcome: { kind: 'approved' }, agentId: 'local-1', decidedAt: NOW })
        const recovered = await reconcileSelfMcpProposal(deps, 'local-1', claim.proposal)
        expect(recovered.status).toBe('applied')
        const receipt = (await store.receipts.byProposal('local-1', 'prop-1')).at(-1)
        expect(receipt?.outcome).toBe('applied_unverified')
        // No second registration: reconcile never re-applies.
        expect(config.calls).not.toContain('apply')
    })

    it('lost acknowledgement with nothing applied releases back to pending — restart never auto-approves', async () => {
        const { deps, store, config } = make()
        await seedProposal(store)
        const claim = await store.claim('local-1', 'prop-1', 1)
        if (claim.result !== 'transitioned') throw new Error('claim failed')
        const recovered = await reconcileSelfMcpProposal(deps, 'local-1', claim.proposal)
        expect(recovered.status).toBe('pending')
        expect(config.calls).not.toContain('apply')
        expect((await store.receipts.byProposal('local-1', 'prop-1'))).toHaveLength(0)
    })

    it('startup recovery with includeClaimed releases leftover claimed rows', async () => {
        const { deps, store } = make()
        await seedProposal(store)
        await store.claim('local-1', 'prop-1', 1)
        await reconcileSelfMcpProposals(deps, 'local-1', { includeClaimed: true })
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('pending')
    })
})

describe('dismiss — human cancel', () => {
    it('cancels a pending proposal with a durable receipt', async () => {
        const { deps, store } = make()
        await seedProposal(store)
        const result = await dismissSelfMcpProposal(deps, 'local-1', 'prop-1', 1)
        expect(result.outcome).toBe('cancelled')
        expect((await store.get('local-1', 'prop-1'))?.status).toBe('cancelled')
        expect((await store.receipts.byProposal('local-1', 'prop-1')).at(-1)?.outcome).toBe('cancelled')
    })

    it('cannot cancel an already-applied server and converges to the saved result', async () => {
        const { deps, store } = make()
        await seedProposal(store)
        const result = await decideSelfMcpProposal(deps, 'local-1', approve())
        expect(result.outcome).toBe('applied')
        const dismiss = await dismissSelfMcpProposal(deps, 'local-1', 'prop-1', 1)
        expect(dismiss.outcome).toBe('applied')
        expect(dismiss.message).toContain('already saved')
    })

    it('refuses a stale dismiss', async () => {
        const { deps, store } = make()
        await seedProposal(store)
        await expect(dismissSelfMcpProposal(deps, 'local-1', 'prop-1', 99)).rejects.toThrow(SelfMcpStaleProposalError)
    })

    it('throws for a missing proposal', async () => {
        const { deps } = make()
        await expect(dismissSelfMcpProposal(deps, 'local-1', 'missing', 1)).rejects.toThrow(SelfMcpProposalNotFoundError)
    })
})
