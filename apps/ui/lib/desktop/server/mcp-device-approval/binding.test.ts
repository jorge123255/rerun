import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import type { DeviceReviewAuthority } from './service'
import { desktopMcpDeviceReviewSchema } from './store'
import { remoteMcpDeviceClientSchema, remoteMcpOAuthSchema, remoteMcpStore } from '../mcp/store'
import { credentialGenerationToken } from '../mcp/credential-generation'
import { remoteMcpOAuthAttemptSchema } from '../mcp/oauth-attempt'
import type { OAuthDeviceForm } from '../mcp/oauth-network'
import { bindApprovedMcpDeviceCustody } from '../mcp-device-custody/binding'
import { createMcpDeviceBroker } from '../mcp-device-custody/broker'
import { createEncryptedDeviceCustodyStore, desktopMcpDeviceCustodySchema } from '../mcp-device-custody/store'
import type { ApprovedDeviceMethod, DeviceApproval } from '../mcp-device-custody/model'
import { randomUUID } from 'node:crypto'
const mocks = vi.hoisted(() => ({ context: vi.fn(), ports: vi.fn(), discover: vi.fn() }))
vi.mock('../mcp-sign-in/binding', () => ({ desktopMcpSignInPorts: mocks.ports }))
vi.mock('../mcp/oauth-network', async original => ({ ...await original<typeof import('../mcp/oauth-network')>(), discoverDeviceOAuth: mocks.discover }))
import { bindTrustedMcpDeviceMethodReview } from './binding'

const clients: Client[] = [], roots: string[] = [], cleanup: (() => void)[] = []
afterEach(async () => {
    cleanup.splice(0).forEach(close => close())
    clients.splice(0).forEach(db => db.close())
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
beforeEach(() => { mocks.context.mockReset(); mocks.ports.mockReset(); mocks.discover.mockReset(); mocks.ports.mockResolvedValue({ deviceMethodAuthority: mocks.context }) })
async function fixture(kind: ApprovedDeviceMethod['kind'] = 'device-code-link-v1') {
    const root = await mkdtemp(join(tmpdir(), 'rerun-device-method-binding-')); roots.push(root)
    const db = createClient({ url: `file:${join(root, 'fixture.db')}` }); clients.push(db)
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('coworker');
        CREATE TABLE desktop_remote_mcp(id TEXT, transport TEXT, agent_id TEXT, name TEXT, url TEXT, revision TEXT, bearer TEXT, PRIMARY KEY(agent_id,name));
        INSERT INTO desktop_remote_mcp VALUES('registration','http','coworker','docs','https://docs.example/mcp','r1',NULL);
        ${remoteMcpOAuthSchema} ${remoteMcpOAuthAttemptSchema} ${remoteMcpDeviceClientSchema} ${desktopMcpDeviceReviewSchema} ${desktopMcpDeviceCustodySchema}`)
    const signal = new AbortController().signal, runtime = { workspaceId: 1 } as DesktopRuntime
    const source = { agentId: 'coworker', sessionId: 'local-chat', runId: 'source-run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'exact', server: { name: 'docs', revision: 'r1', url: 'https://docs.example/mcp', displayName: 'Docs' } }
    const owner: DeviceReviewAuthority = { workspaceId: '1', owner: source.agentId, engineAgentId: 'engine-coworker', sessionId: 'engine-chat', name: source.server.name, revision: 'r1', url: source.server.url, signal, check() {} }
    mocks.context.mockResolvedValue(owner)
    const key = () => Buffer.alloc(32, 17), store = remoteMcpStore(db, key)
    const initial = (await store.credentialState(owner.owner, owner.name))!
    const method = vi.fn(async () => ({ value: { registrationId: initial.registrationId,
        credentialGeneration: credentialGenerationToken(key(), owner.owner, owner.name, initial, initial.sealed), validUntil: 2_000_000,
        method: { kind, resource: source.server.url, issuer: 'https://issuer.example/', deviceEndpoint: 'https://issuer.example/device', tokenEndpoint: 'https://issuer.example/token', verificationUri: 'https://issuer.example/activate', clientId: 'public-client', scope: 'read' } }, signal, check() {} }))
    const stopCustody = vi.fn(async () => {})
    let time = 1_000_000
    const now = () => time
    const review = bindTrustedMcpDeviceMethodReview({ db, key, store, runtime, shutdown: signal, method, stopCustody, now })
    cleanup.push(review.dispose)
    return { db, key, store, now, advance: (ms = 5000) => { time += ms }, source, owner, signal, runtime, method, review, stopCustody, custody: createEncryptedDeviceCustodyStore(db, key) }
}

it('reuses the existing canonical human-source context and current immutable registration', async () => {
    const f = await fixture()
    expect(await f.review.review(f.source, f.signal)).toMatchObject({ state: 'pending', owner: 'coworker', localSessionId: 'local-chat' })
    expect(mocks.ports).toHaveBeenCalledWith(f.runtime, 'local-chat')
    expect(mocks.context).toHaveBeenCalledWith(f.source, expect.any(AbortSignal), 'review')
    expect(f.method).toHaveBeenCalledWith(expect.objectContaining({ owner: 'coworker', engineAgentId: 'engine-coworker', sessionId: 'engine-chat', registrationId: 'registration', revision: 'r1' }), expect.any(AbortSignal))
})

it('derives review from the saved public client and refuses an unconfigured or changed registration', async () => {
    const f = await fixture('device-code-rfc8628-v1')
    const review = bindTrustedMcpDeviceMethodReview({ ...f, shutdown: f.signal, method: undefined })
    cleanup.push(review.dispose)
    await expect(review.review(f.source, f.signal)).rejects.toThrow('Device method review is unavailable')
    expect(mocks.discover).not.toHaveBeenCalled()

    const { method } = (await f.method()).value
    const deviceClient = { clientId: method.clientId, verificationUri: method.verificationUri }
    const [saved] = await f.store.save(f.owner.owner, { name: f.owner.name, url: f.owner.url, revision: f.owner.revision, deviceClient })
    const source = { ...f.source, server: { ...f.source.server, revision: saved.revision } }
    mocks.context.mockResolvedValue({ ...f.owner, revision: saved.revision })
    mocks.discover.mockResolvedValue(method)
    await expect(review.review(source, f.signal)).resolves.toMatchObject({ state: 'pending', method, registrationRevision: saved.revision })
    expect(mocks.discover).toHaveBeenCalledWith(f.owner.url, deviceClient, expect.any(AbortSignal))

    const anotherStore = remoteMcpStore(f.db, f.key)
    mocks.discover.mockImplementationOnce(async () => {
        await anotherStore.save(f.owner.owner, { name: f.owner.name, url: f.owner.url, revision: saved.revision })
        return method
    })
    await expect(review.review(source, f.signal)).rejects.toThrow('Device method review is unavailable')
})

it('refuses source/permission failure or a changed registration before trusted discovery', async () => {
    const f = await fixture()
    mocks.context.mockRejectedValueOnce(new Error('FIXTURE_PRIVATE_AUTHORITY_ERROR'))
    await expect(f.review.review(f.source, f.signal)).rejects.toThrow('Device method review is unavailable')
    expect(f.method).not.toHaveBeenCalled()
    await f.db.execute("UPDATE desktop_remote_mcp SET revision='r2'")
    await expect(f.review.review(f.source, f.signal)).rejects.toThrow()
    expect(f.method).not.toHaveBeenCalled()
})

it('refuses method metadata for another immutable registration', async () => {
    const f = await fixture(), lease = await f.method()
    f.method.mockResolvedValue({ ...lease, value: { ...lease.value, registrationId: 'foreign' } })
    await expect(f.review.review(f.source, f.signal)).rejects.toThrow()
    expect((await f.db.execute('SELECT * FROM desktop_mcp_device_reviews')).rows).toEqual([])
})

it('never retires another approval sharing the registration/generation custody slot', async () => {
    const f = await fixture(), view = await f.review.review(f.source, f.signal)
    await f.review.decide(f.source, { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'approve-device-method' }, f.signal)
    const lease = (await f.review.approvedMethod({ owner: f.owner.owner, name: f.owner.name, revision: f.owner.revision, url: f.owner.url,
        identity: { engineAgentId: f.owner.engineAgentId, sessionId: f.owner.sessionId, runId: 'active-run' } }, f.signal))!
    const foreign = { ...lease.approval as DeviceApproval, approvalId: randomUUID(), sessionId: 'another-engine-chat' }
    await f.custody.create(foreign, { approval: foreign, phase: 'waiting', deviceCode: 'FIXTURE_OTHER_ATTEMPT', startedAt: 1_000_000, expiresAt: 1_100_000, nextPollAt: 1_005_000, interval: 5, requests: {} }, () => {})
    const before = await f.custody.read(foreign)
    await f.review.decide(f.source, { reviewId: view.reviewId, revision: view.revision, decisionId: randomUUID(), operation: 'stop-device-method' }, f.signal)
    expect(f.stopCustody).not.toHaveBeenCalled()
    expect(await f.custody.read(foreign)).toEqual(before)
})

it('stores a real broker response privately and exposes only the scoped human code until the credential is committed', async () => {
    const f = await fixture('device-code-rfc8628-v1')
    const initial = await f.review.review(f.source, f.signal)
    expect(await f.review.readAuthorization(f.source, initial.reviewId, initial.revision, f.signal)).toBeNull()
    const view = await f.review.decide(f.source, { reviewId: initial.reviewId, revision: initial.revision, decisionId: randomUUID(), operation: 'approve-device-method' }, f.signal)
    const form = vi.fn<OAuthDeviceForm>()
        .mockResolvedValueOnce({ status: 200, body: { device_code: 'PRIVATE-DEVICE', user_code: 'HUMAN-QA', verification_uri: view.method.verificationUri, expires_in: 300 } })
        .mockResolvedValueOnce({ status: 400, body: { error: 'authorization_pending' } })
        .mockResolvedValueOnce({ status: 200, body: { token_type: 'bearer', access_token: 'PRIVATE-TOKEN', expires_in: 900, scope: 'read' } })
    const binding = bindApprovedMcpDeviceCustody({
        db: f.db, key: f.key, workspaceId: '1', now: f.now, watchOwner: () => () => {},
        service: { store: f.store, shutdownSignal: f.signal, authorizeRun: async () => f.owner.owner, runtime: { probe: async () => ({ tools: [] }) } },
        approvedMethod: f.review.approvedMethod, broker: createMcpDeviceBroker(form),
    })
    cleanup.push(binding.dispose)
    const request = { identity: { engineAgentId: f.owner.engineAgentId, sessionId: f.owner.sessionId, runId: 'current-run' }, toolCallId: 'start-rfc', name: f.owner.name, action: 'start' }
    const waiting = await binding.dispatch(request, f.signal)
    expect(waiting).toMatchObject({ result: { view: { state: 'waiting', verificationUri: view.method.verificationUri } } })
    expect(JSON.stringify(waiting)).not.toMatch(/HUMAN-QA|PRIVATE-DEVICE|userCode/)
    expect(await f.review.readAuthorization(f.source, view.reviewId, view.revision, f.signal)).toEqual({
        reviewId: view.reviewId, revision: view.revision, userCode: 'HUMAN-QA', verificationUri: view.method.verificationUri, expiresAt: f.now() + 300_000,
    })
    expect(await f.review.readAuthorization({ ...f.source, runId: 'different-source' }, view.reviewId, view.revision, f.signal)).toBeNull()
    expect(await f.review.readAuthorization(f.source, view.reviewId, randomUUID(), f.signal)).toBeNull()
    expect(form).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((await f.db.execute('SELECT sealed FROM desktop_mcp_device_custody')).rows)).not.toMatch(/HUMAN-QA|PRIVATE-DEVICE/)
    f.advance()
    expect(await binding.dispatch({ ...request, toolCallId: 'poll-rfc', action: 'complete' }, f.signal)).toMatchObject({ result: { view: { state: 'pending' } } })
    f.advance()
    expect(await binding.dispatch({ ...request, toolCallId: 'complete-rfc', action: 'complete' }, f.signal)).toMatchObject({ result: { view: { state: 'connected' } } })
    expect(await f.review.readAuthorization(f.source, view.reviewId, view.revision, f.signal)).toBeNull()
    expect(await f.store.readOAuth(f.owner.owner, f.owner.name)).toMatchObject({ accessToken: 'PRIVATE-TOKEN' })
})
