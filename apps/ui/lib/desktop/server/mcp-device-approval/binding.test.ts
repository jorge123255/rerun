import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import type { DeviceReviewAuthority } from './service'
import { desktopMcpDeviceReviewSchema } from './store'
import { remoteMcpStore } from '../mcp/store'
import { createEncryptedDeviceCustodyStore, desktopMcpDeviceCustodySchema } from '../mcp-device-custody/store'
import type { DeviceApproval } from '../mcp-device-custody/model'
import { randomUUID } from 'node:crypto'
const mocks = vi.hoisted(() => ({ context: vi.fn(), ports: vi.fn() }))
vi.mock('../mcp-sign-in/binding', () => ({ desktopMcpSignInPorts: mocks.ports }))
import { bindTrustedMcpDeviceMethodReview } from './binding'

const clients: Client[] = [], cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(close => close()); clients.splice(0).forEach(db => db.close()) })
beforeEach(() => { mocks.context.mockReset(); mocks.ports.mockReset(); mocks.ports.mockResolvedValue({ deviceMethodAuthority: mocks.context }) })
async function fixture() {
    const db = createClient({ url: 'file::memory:' }); clients.push(db)
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('coworker');
        CREATE TABLE desktop_remote_mcp(id TEXT, transport TEXT, agent_id TEXT, name TEXT, url TEXT, revision TEXT, bearer TEXT, PRIMARY KEY(agent_id,name));
        INSERT INTO desktop_remote_mcp VALUES('registration','http','coworker','docs','https://docs.example/mcp','r1',NULL); ${desktopMcpDeviceReviewSchema} ${desktopMcpDeviceCustodySchema}`)
    const signal = new AbortController().signal, runtime = { workspaceId: 1 } as DesktopRuntime
    const source = { agentId: 'coworker', sessionId: 'local-chat', runId: 'source-run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'exact', server: { name: 'docs', revision: 'r1', url: 'https://docs.example/mcp', displayName: 'Docs' } }
    const owner: DeviceReviewAuthority = { workspaceId: '1', owner: source.agentId, engineAgentId: 'engine-coworker', sessionId: 'engine-chat', name: source.server.name, revision: 'r1', url: source.server.url, signal, check() {} }
    mocks.context.mockResolvedValue(owner)
    const method = vi.fn(async () => ({ value: { registrationId: 'registration', credentialGeneration: 'fixture-generation', validUntil: 2_000_000,
        method: { kind: 'device-code-link-v1', resource: source.server.url, issuer: 'https://issuer.example/', deviceEndpoint: 'https://issuer.example/device', tokenEndpoint: 'https://issuer.example/token', verificationUri: 'https://issuer.example/activate', clientId: 'public-client', scope: 'read' } }, signal, check() {} }))
    const key = () => Buffer.alloc(32, 17), store = remoteMcpStore(db, key)
    const stopCustody = vi.fn(async () => {})
    const review = bindTrustedMcpDeviceMethodReview({ db, key, store, runtime, shutdown: signal, method, stopCustody, now: () => 1_000_000 })
    cleanup.push(review.dispose)
    return { db, source, owner, signal, runtime, method, review, stopCustody, custody: createEncryptedDeviceCustodyStore(db, key) }
}

it('reuses the existing canonical human-source context and current immutable registration', async () => {
    const f = await fixture()
    expect(await f.review.review(f.source, f.signal)).toMatchObject({ state: 'pending', owner: 'coworker', localSessionId: 'local-chat' })
    expect(mocks.ports).toHaveBeenCalledWith(f.runtime, 'local-chat')
    expect(mocks.context).toHaveBeenCalledWith(f.source, expect.any(AbortSignal), 'review')
    expect(f.method).toHaveBeenCalledWith(expect.objectContaining({ owner: 'coworker', engineAgentId: 'engine-coworker', sessionId: 'engine-chat', registrationId: 'registration', revision: 'r1' }), expect.any(AbortSignal))
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
