import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { remoteMcpStore, remoteMcpOAuthSchema } from '../mcp/store'
import { credentialGenerationToken } from '../mcp/credential-generation'
import { bindApprovedMcpDeviceCustody } from '../mcp-device-custody/binding'
import { desktopMcpDeviceCustodySchema } from '../mcp-device-custody/store'
import { digest, type ApprovedDeviceMethod, type DeviceApproval } from '../mcp-device-custody/model'
import { createDeviceReviewStore, desktopMcpDeviceReviewSchema } from './store'
import { createTrustedMcpDeviceMethodReview, type DeviceMethodReviewPorts, type DeviceReviewAuthority } from './service'

const databases: Client[] = [], roots: string[] = [], cleanup: (() => void)[] = []
afterEach(async () => {
    cleanup.splice(0).forEach(close => close()); databases.splice(0).forEach(db => db.close())
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-device-method-review-')); roots.push(root)
    const db = createClient({ url: `file:${join(root, 'fixture.db')}` }); databases.push(db)
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('coworker');
        CREATE TABLE desktop_remote_mcp(id TEXT, transport TEXT, agent_id TEXT, name TEXT, url TEXT, revision TEXT, bearer TEXT, PRIMARY KEY(agent_id,name));
        INSERT INTO desktop_remote_mcp VALUES('registration','http','coworker','docs','https://docs.example/mcp','r1',NULL);
        ${remoteMcpOAuthSchema} ${desktopMcpDeviceCustodySchema} ${desktopMcpDeviceReviewSchema}`)
    const key = () => Buffer.alloc(32, 23), store = remoteMcpStore(db, key), reviewStore = createDeviceReviewStore(db, key)
    const source: DesktopMcpSignInSource = { agentId: 'coworker', sessionId: 'local-chat', runId: 'source-run', sourceMessageId: 'source-message', toolCallId: 'source-tool', fingerprint: 'exact-source-body',
        server: { name: 'docs', revision: 'r1', url: 'https://docs.example/mcp', displayName: 'Docs' } }
    const identity = { engineAgentId: 'engine-coworker', sessionId: 'engine-chat', runId: 'new-approved-run' }
    const target = { owner: source.agentId, identity, name: source.server.name, revision: source.server.revision, url: source.server.url }
    let time = 1_000_000, allowed = true, generationOverride: string | undefined, credential = new AbortController()
    let method: ApprovedDeviceMethod = { kind: 'device-code-link-v1', resource: source.server.url, issuer: 'https://issuer.example/', clientId: 'fixture-public-client', scope: 'notes.read notes.write',
        deviceEndpoint: 'https://issuer.example/device', tokenEndpoint: 'https://issuer.example/token', verificationUri: 'https://issuer.example/activate' }
    const shutdown = new AbortController()
    const start = vi.fn(async () => ({ deviceCode: 'FIXTURE_DEVICE_CODE', verificationUri: method.verificationUri, expiresIn: 120, interval: 5 }))
    const poll = vi.fn(async (): Promise<unknown> => ({ state: 'authorized', token: { tokenType: 'Bearer', accessToken: 'FIXTURE_ACCESS_TOKEN', refreshToken: 'FIXTURE_REFRESH_TOKEN', expiresIn: 600, scope: method.scope } }))
    const service = { store, shutdownSignal: shutdown.signal,
        authorizeRun: vi.fn(async (input: typeof identity) => { if (!allowed || digest(input) !== digest(identity)) throw new Error('inactive'); return source.agentId }),
        runtime: { probe: vi.fn(async () => ({ tools: [{ name: 'search' }] })) },
    }
    let custody: ReturnType<typeof bindApprovedMcpDeviceCustody> | undefined
    const ports: DeviceMethodReviewPorts = {
        workspaceId: 'workspace', store: reviewStore, shutdown: shutdown.signal, now: () => time,
        authority: vi.fn(async (input: DesktopMcpSignInSource, signal: AbortSignal) => {
            if (!allowed || digest(input) !== digest(source)) throw new Error('source changed')
            return { workspaceId: 'workspace', owner: source.agentId, engineAgentId: identity.engineAgentId, sessionId: identity.sessionId,
                name: source.server.name, revision: source.server.revision, url: source.server.url, signal,
                check() { signal.throwIfAborted(); if (!allowed) throw new Error('revoked') } }
        }),
        method: vi.fn(async (owner: DeviceReviewAuthority, signal: AbortSignal) => {
            const watch = store.lifecycle.watchCredentials(owner.owner, owner.name)
            const current = await store.credentialState(owner.owner, owner.name)
            const override = generationOverride, selected = digest(method), credentialSignal = credential.signal
            if (!current || current.revision !== owner.revision || current.resource !== owner.url) throw new Error('registration changed')
            const generation = override ?? credentialGenerationToken(key(), owner.owner, owner.name, current, current.sealed)
            return { value: { registrationId: current.registrationId, method: structuredClone(method), credentialGeneration: generation, validUntil: 2_000_000 }, signal: credentialSignal,
                check() {
                    signal.throwIfAborted(); credentialSignal.throwIfAborted(); watch()
                    if (generationOverride !== override || digest(method) !== selected) throw new Error('method or generation changed')
                } }
        }),
        stopCustody: vi.fn(async (approval: DeviceApproval) => { await custody?.stop(approval) }),
    }
    const make = () => { const review = createTrustedMcpDeviceMethodReview(ports); cleanup.push(review.dispose); return review }
    const review = make(), signal = new AbortController().signal
    const bind = (reader = review) => {
        const value = bindApprovedMcpDeviceCustody({ db, key, workspaceId: 'workspace', service, watchOwner: () => () => { if (!allowed) throw new Error('revoked') }, approvedMethod: reader.approvedMethod, broker: { start, poll }, now: () => time })
        custody = value; cleanup.push(value.dispose); return value
    }
    return { db, source, target, identity, ports, review, make, bind, signal, start, poll, service, store, reviewStore, shutdown,
        request: { identity, toolCallId: 'start-id', action: 'start', name: 'docs' },
        advance: (ms = 5000) => { time += ms }, deny: () => { allowed = false },
        changeGeneration: () => { credential.abort(); generationOverride = 'FIXTURE_GENERATION_2'; credential = new AbortController() },
        changeMethod: (change: Partial<ApprovedDeviceMethod>) => { method = { ...method, ...change } },
        async approve() {
            const view = await review.review(source, signal)
            const decision = { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'approve-device-method' as const }
            return { view: await review.decide(source, decision, signal), decision }
        },
    }
}

it('requires a separate exact human method decision before the real custody binding can use a fake broker', async () => {
    const f = await fixture(), network = vi.fn(() => { throw new Error('External effects forbidden') })
    vi.stubGlobal('fetch', network)
    const binding = f.bind()
    const pending = await f.review.review(f.source, f.signal)
    expect(pending).toMatchObject({ state: 'pending', method: { issuer: 'https://issuer.example/', clientId: 'fixture-public-client', scope: 'notes.read notes.write' } })
    await expect(binding.dispatch(f.request, f.signal)).resolves.toMatchObject({ result: { view: { state: 'approval_required' } } })
    expect(f.start).not.toHaveBeenCalled()
    const approved = await f.approve()
    expect(approved.view).toMatchObject({ state: 'approved', receipt: { outcome: 'approved', decisionId: approved.decision.decisionId } })
    expect(await f.review.decide(f.source, approved.decision, f.signal)).toEqual(approved.view)
    const waiting = await binding.dispatch(f.request, f.signal); f.advance()
    const connected = await binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'complete-id' }, f.signal)
    expect(connected).toMatchObject({ result: { view: { state: 'connected', tools: ['docs_search'] } } })
    const output = JSON.stringify([pending, approved.view, waiting, connected])
    expect(output).not.toMatch(/FIXTURE_|credentialGeneration|accessToken|refreshToken|deviceCode/)
    const raw = JSON.stringify((await f.db.execute('SELECT * FROM desktop_mcp_device_reviews')).rows)
    expect(raw).not.toMatch(/FIXTURE_|issuer\.example|notes\.read/)
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1)
    expect(network).not.toHaveBeenCalled()
})

it('restores an approved receipt without starting or polling anything, then revalidates the current source and generation', async () => {
    const f = await fixture(), { view } = await f.approve()
    f.review.dispose()
    const restored = f.make()
    expect(await restored.review(f.source, f.signal)).toEqual(view)
    expect((await restored.approvedMethod(f.target, f.signal))?.approval).toMatchObject({ registrationId: 'registration', revision: 'r1', sessionId: f.identity.sessionId })
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
    f.changeGeneration()
    await expect(restored.approvedMethod(f.target, f.signal)).rejects.toThrow('Device method review is unavailable')
})

it.each(['issuer', 'clientId', 'scope', 'resource', 'deviceEndpoint', 'tokenEndpoint', 'verificationUri'] as const)('rejects a changed reviewed %s before approval', async field => {
    const f = await fixture(), view = await f.review.review(f.source, f.signal)
    f.changeMethod({ [field]: field === 'scope' || field === 'clientId' ? 'changed' : 'https://other.example/changed' })
    await expect(f.review.decide(f.source, { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'approve-device-method' }, f.signal)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
})

it.each(['workspaceId', 'owner', 'engineAgentId', 'sessionId'] as const)('never grants a lease for a foreign %s', async field => {
    const f = await fixture(); await f.approve()
    if (field === 'workspaceId') {
        const foreign = createTrustedMcpDeviceMethodReview({ ...f.ports, workspaceId: 'foreign' }); cleanup.push(foreign.dispose)
        await expect(foreign.approvedMethod(f.target, f.signal)).resolves.toBeNull()
    } else {
        const target = field === 'owner' ? { ...f.target, owner: 'foreign' } : { ...f.target, identity: { ...f.identity, [field]: 'foreign' } }
        await expect(f.review.approvedMethod(target, f.signal)).resolves.toBeNull()
    }
    expect(f.start).not.toHaveBeenCalled()
})

it('refuses stale IDs, browser Connect and renderer-supplied method/credential fields', async () => {
    const f = await fixture(), view = await f.review.review(f.source, f.signal)
    const base = { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'approve-device-method' }
    for (const input of [{ ...base, revision: randomUUID() }, { ...base, operation: 'connect' }, { ...base, method: view.method }, { ...base, credentialGeneration: 'model-claimed' }, { ...base, deviceCode: 'FIXTURE_PRIVATE' }]) {
        await expect(f.review.decide(f.source, input, f.signal)).rejects.toThrow('Device method review is unavailable')
    }
    await expect(f.review.decide({ ...f.source, sessionId: 'foreign-chat' }, base, f.signal)).rejects.toThrow()
    await expect(f.review.approvedMethod(f.target, f.signal)).resolves.toBeNull()
    expect(f.start).not.toHaveBeenCalled()
})

it('refuses an expired review and expires an approved lease without a broker effect', async () => {
    const f = await fixture(), view = await f.review.review(f.source, f.signal)
    f.advance(300_000)
    await expect(f.review.decide(f.source, { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'approve-device-method' }, f.signal)).rejects.toThrow()
    const g = await fixture(); await g.approve()
    const lease = await g.review.approvedMethod(g.target, g.signal)
    g.advance(1_000_000)
    expect(() => lease?.check()).toThrow()
    await expect(g.review.approvedMethod(g.target, g.signal)).resolves.toBeNull()
    expect(f.start).not.toHaveBeenCalled(); expect(g.start).not.toHaveBeenCalled()
})

it('Stop persists retirement, aborts the issued lease and preserves the original human decision after recreation', async () => {
    const f = await fixture(), { view, decision } = await f.approve(), binding = f.bind()
    await binding.dispatch(f.request, f.signal)
    const lease = (await f.review.approvedMethod(f.target, f.signal))!
    const input = { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'stop-device-method' }
    expect(await f.review.decide(f.source, input, f.signal)).toMatchObject({ state: 'stopped', receipt: { decisionId: decision.decisionId, outcome: 'approved' } })
    expect(lease.signal.aborted).toBe(true); expect(() => lease.check()).toThrow()
    f.review.dispose()
    const restored = f.make()
    expect(await restored.review(f.source, f.signal)).toMatchObject({ state: 'stopped' })
    await expect(restored.approvedMethod(f.target, f.signal)).resolves.toBeNull()
    expect(await restored.decide(f.source, input, f.signal)).toMatchObject({ state: 'stopped' })
    const row = (await f.db.execute('SELECT sealed FROM desktop_mcp_device_custody')).rows[0]
    expect(row).toBeDefined(); expect(JSON.stringify(row)).not.toContain('FIXTURE_')
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
})

it('revoke aborts a delayed poll lease and prevents late installation, replay and secret diagnostics', async () => {
    const f = await fixture(); await f.approve(); const binding = f.bind()
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    await binding.dispatch(f.request, f.signal); f.advance()
    let entered!: () => void, finish!: (value: unknown) => void
    const started = new Promise<void>(resolve => { entered = resolve }), result = new Promise<unknown>(resolve => { finish = resolve })
    f.poll.mockImplementationOnce(async () => { entered(); return result })
    const operation = binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'late-token' }, f.signal)
    await started; await f.review.revokeOwner(f.source.agentId)
    finish({ state: 'authorized', token: { accessToken: 'FIXTURE_LATE_TOKEN', tokenType: 'Bearer', expiresIn: 600 } })
    await expect(operation).resolves.toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(await f.store.readOAuth(f.source.agentId, 'docs')).toBeNull()
    expect(await f.make().approvedMethod(f.target, f.signal)).toBeNull()
    expect(f.poll).toHaveBeenCalledTimes(1); expect(f.service.runtime.probe).not.toHaveBeenCalled()
    expect(logs.every(log => log.mock.calls.length === 0)).toBe(true)
})

it('never silently replaces a declined, damaged or unknown saved review', async () => {
    const f = await fixture(), view = await f.review.review(f.source, f.signal)
    const decline = { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'decline-device-method' }
    expect(await f.review.decide(f.source, decline, f.signal)).toMatchObject({ state: 'declined' })
    expect(await f.review.review(f.source, f.signal)).toMatchObject({ reviewId: view.reviewId, state: 'declined' })
    await expect(f.review.decide(f.source, { ...decline, operation: 'approve-device-method', decisionId: randomUUID() }, f.signal)).rejects.toThrow()
    await f.db.execute("UPDATE desktop_mcp_device_reviews SET sealed='damaged'")
    await expect(f.make().review(f.source, f.signal)).rejects.toThrow()
    expect((await f.db.execute('SELECT review_id FROM desktop_mcp_device_reviews')).rows).toHaveLength(1)
    expect(f.start).not.toHaveBeenCalled()
})

it('aborts the actual issued lease signal at the approved deadline', async () => {
    const f = await fixture(); await f.approve()
    vi.useFakeTimers()
    const lease = (await f.review.approvedMethod(f.target, f.signal))!
    f.advance(1_000_000)
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(lease.signal.aborted).toBe(true)
    expect(() => lease.check()).toThrow()
    expect(f.start).not.toHaveBeenCalled()
})

it('preserves unknown custody even while the human method receipt remains approved', async () => {
    const f = await fixture(); await f.approve(); const binding = f.bind()
    await binding.dispatch(f.request, f.signal); f.advance()
    f.poll.mockResolvedValueOnce({ state: 'unknown', diagnostic: 'FIXTURE_PRIVATE_DIAGNOSTIC' })
    const request = { ...f.request, action: 'complete', toolCallId: 'unknown-complete' }
    await expect(binding.dispatch(request, f.signal)).resolves.toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(await f.review.review(f.source, f.signal)).toMatchObject({ state: 'approved' })
    await expect(binding.dispatch({ ...request, toolCallId: 'new-complete' }, f.signal)).resolves.toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(f.poll).toHaveBeenCalledTimes(1)
    expect(await f.store.readOAuth(f.source.agentId, 'docs')).toBeNull()
})

it('does not infer a fresh approval when the additive review schema is missing', async () => {
    const f = await fixture()
    await f.db.execute('DROP TABLE desktop_mcp_device_reviews')
    await expect(f.review.review(f.source, f.signal)).rejects.toThrow('Device method review is unavailable')
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
    await f.db.executeMultiple(desktopMcpDeviceReviewSchema)
    await f.db.executeMultiple(desktopMcpDeviceReviewSchema)
    expect(await f.review.review(f.source, f.signal)).toMatchObject({ state: 'pending' })
    expect((await f.store.list(f.source.agentId))[0]).toMatchObject({ id: 'registration', revision: 'r1' })
})

it('retiring a proposal that was never approved does not touch pending device custody', async () => {
    const f = await fixture(), view = await f.review.review(f.source, f.signal)
    await f.review.decide(f.source, { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'stop-device-method' }, f.signal)
    expect(f.ports.stopCustody).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
})
