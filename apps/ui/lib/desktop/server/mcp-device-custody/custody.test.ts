import { createClient, type Client } from '@libsql/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApprovedMcpDeviceCustody, type DeviceCustodyPorts } from './custody'
import { createEncryptedDeviceCustodyStore, desktopMcpDeviceCustodySchema } from './store'
import { remoteMcpLifecycle } from '../mcp/lifecycle'
import { slotOf, type DeviceApproval, type DeviceTarget } from './model'

const databases: Client[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })
const identity = { engineAgentId: 'engine-a', sessionId: 'chat-a', runId: 'run-a' }
const target: DeviceTarget = { owner: 'agent-a', identity, name: 'docs', revision: 'revision-a', url: 'https://docs.example/mcp', approvalId: 'human-approved-a', requestId: 'start-a' }
const initialApproval: DeviceApproval = {
    approvalId: target.approvalId, workspaceId: 'workspace-a', owner: target.owner,
    engineAgentId: identity.engineAgentId, sessionId: identity.sessionId,
    registrationId: 'registration-a', name: target.name, revision: target.revision, credentialGeneration: 'generation-a', approvedUntil: 1_500_000,
    method: { kind: 'device-code-link-v1', resource: target.url, issuer: 'https://auth.example/',
        deviceEndpoint: 'https://auth.example/device', tokenEndpoint: 'https://auth.example/token',
        verificationUri: 'https://auth.example/activate', clientId: 'fixture-client', scope: 'read' },
}
const started = { deviceCode: 'FIXTURE_DEVICE_SECRET', verificationUri: initialApproval.method.verificationUri, expiresIn: 120, interval: 5 }
const authorized = { state: 'authorized', token: { accessToken: 'FIXTURE_ACCESS_SECRET', refreshToken: 'FIXTURE_REFRESH_SECRET', tokenType: 'Bearer', expiresIn: 600, scope: 'read' } }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

async function fixture() {
    const db = createClient({ url: ':memory:' }); databases.push(db)
    await db.executeMultiple(`PRAGMA foreign_keys=ON; CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES ('agent-a'); ${desktopMcpDeviceCustodySchema}`)
    const store = createEncryptedDeviceCustodyStore(db, () => Buffer.alloc(32, 17))
    let approval: unknown = structuredClone(initialApproval), time = 1_000_000, allowed = true
    const revoked = new AbortController(), shutdown = new AbortController(), lifecycle = remoteMcpLifecycle()
    const start = vi.fn(async () => started as unknown), poll = vi.fn(async () => authorized as unknown)
    const writeCredential = vi.fn(async () => {})
    const ports: DeviceCustodyPorts = {
        store, shutdown: shutdown.signal, now: () => time,
        approval: vi.fn(async () => allowed ? { approval, signal: revoked.signal, check: () => { if (!allowed) throw new Error('revoked') } } : null),
        lifecycle: (current, controller) => lifecycle.admit(current.owner, current.name, controller),
        broker: { start, poll }, writeCredential,
    }
    const make = () => createApprovedMcpDeviceCustody(ports)
    const custody = make(), signal = new AbortController().signal
    return { db, store, ports, make, custody, signal, lifecycle, start, poll, writeCredential, revoked, shutdown,
        advance: (ms: number) => { time += ms }, change: (value: unknown) => { approval = value }, deny: () => { allowed = false },
        startAttempt: () => custody.fallback.start(target, signal),
        complete: (requestId = 'complete-a') => custody.fallback.complete({ ...target, requestId }, signal),
    }
}

describe('approved MCP device custody (offline sources)', () => {
    it('reserves, encrypts, explicitly completes, and returns no device/token bytes', async () => {
        const f = await fixture()
        const waiting = await f.startAttempt()
        expect(waiting).toEqual({ state: 'waiting', verificationUri: started.verificationUri, expiresIn: 120 })
        const raw = JSON.stringify((await f.db.execute('SELECT * FROM desktop_mcp_device_custody')).rows)
        for (const secret of ['FIXTURE_DEVICE_SECRET', 'fixture-client', 'auth.example', 'human-approved-a']) expect(raw).not.toContain(secret)
        f.advance(5000)
        const view = await f.complete()
        expect(view).toEqual({ state: 'connected', tools: [] })
        expect(f.writeCredential).toHaveBeenCalledWith(initialApproval, expect.objectContaining({ accessToken: 'FIXTURE_ACCESS_SECRET', resource: target.url }), expect.any(AbortSignal))
        expect(JSON.stringify([waiting, view])).not.toMatch(/FIXTURE_|deviceCode|accessToken|refreshToken/)
        expect((await f.store.read(initialApproval))?.value.deviceCode).toBeUndefined()
    })

    it('reconciles the same start and completion IDs after remount without replay', async () => {
        const f = await fixture()
        await f.startAttempt(); f.custody.dispose()
        const restored = f.make()
        await expect(restored.fallback.start(target, f.signal)).resolves.toMatchObject({ state: 'waiting' })
        expect(f.start).toHaveBeenCalledTimes(1)
        f.advance(5000)
        await restored.fallback.complete({ ...target, requestId: 'complete-a' }, f.signal)
        const again = f.make()
        expect(f.poll).toHaveBeenCalledTimes(1)
        await expect(again.fallback.complete({ ...target, requestId: 'complete-a' }, f.signal)).resolves.toEqual({ state: 'connected', tools: [] })
        expect(f.poll).toHaveBeenCalledTimes(1); expect(f.writeCredential).toHaveBeenCalledTimes(1)
    })

    it('observational status and construction never start or poll', async () => {
        const f = await fixture()
        await expect(f.custody.inspect(target, f.signal)).resolves.toEqual({ state: 'no_pending' })
        await f.startAttempt(); f.advance(121_000)
        const before = (await f.store.read(initialApproval))!.version
        await expect(f.make().inspect(target, f.signal)).resolves.toEqual({ state: 'failed' })
        expect((await f.store.read(initialApproval))!.version).toBe(before)
        expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
    })

    it('refuses missing approval or broker before reserving an attempt', async () => {
        const f = await fixture(); f.deny()
        await expect(f.startAttempt()).resolves.toEqual({ state: 'approval_required' })
        expect(await f.store.read(initialApproval)).toBeNull()
        const g = await fixture(); g.ports.broker = undefined
        await expect(g.make().fallback.start(target, g.signal)).resolves.toEqual({ state: 'unsupported' })
        expect(await g.store.read(initialApproval)).toBeNull()
    })

    it.each([
        { owner: 'other' }, { revision: 'other' }, { url: 'https://other.example/mcp' },
        { identity: { ...identity, sessionId: 'other' } }, { identity: { ...identity, engineAgentId: 'other' } },
    ])('rejects an altered target before network: %o', async change => {
        const f = await fixture()
        await expect(f.custody.fallback.start({ ...target, ...change }, f.signal)).rejects.toThrow()
        expect(f.start).not.toHaveBeenCalled()
    })

    it.each([
        { kind: 'oauth-pkce' }, { verificationUri: 'https://auth.example/activate?device_code=FIXTURE_DEVICE_SECRET' },
        { tokenEndpoint: 'https://other.example/token' }, { clientSecret: 'NOT_SUPPORTED' },
    ])('refuses unapproved method shapes: %o', async change => {
        const f = await fixture(); f.change({ ...initialApproval, method: { ...initialApproval.method, ...change } })
        await expect(f.startAttempt()).rejects.toThrow('unavailable or unsupported')
        expect(f.start).not.toHaveBeenCalled()
    })

    it('does not expose malformed broker bytes and seals an uncertain start', async () => {
        const f = await fixture()
        f.start.mockResolvedValueOnce({ ...started, userCode: 'FIXTURE_PRIVATE_PROMPT' })
        await expect(f.startAttempt()).resolves.toEqual({ state: 'unknown' })
        await expect(f.make().fallback.start({ ...target, requestId: 'different' }, f.signal)).resolves.toEqual({ state: 'unknown' })
        expect(f.start).toHaveBeenCalledTimes(1)
    })

    it('serializes racing IDs through the SQL reservation even with separate factories', async () => {
        const f = await fixture(), waiting = deferred<unknown>(), entered = deferred<void>()
        f.start.mockImplementationOnce(async () => { entered.resolve(); return waiting.promise })
        const first = f.startAttempt(); await entered.promise
        await expect(f.make().fallback.start({ ...target, requestId: 'racer' }, f.signal)).resolves.toEqual({ state: 'unknown' })
        waiting.resolve(started); await first
        expect(f.start).toHaveBeenCalledTimes(1)
    })

    it('does not replay a possibly issued start after lost acknowledgement or restart', async () => {
        const f = await fixture()
        f.start.mockRejectedValueOnce(new Error('provider response may contain FIXTURE_DEVICE_SECRET'))
        await expect(f.startAttempt()).resolves.toEqual({ state: 'unknown' })
        const restored = f.make()
        await expect(restored.fallback.start(target, f.signal)).resolves.toEqual({ state: 'unknown' })
        await expect(restored.fallback.complete({ ...target, requestId: 'later' }, f.signal)).resolves.toEqual({ state: 'unknown' })
        expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
    })

    it('enforces interval and requires a new explicit ID after a definitive pending response', async () => {
        const f = await fixture(); await f.startAttempt()
        await expect(f.complete()).resolves.toEqual({ state: 'pending' }); expect(f.poll).not.toHaveBeenCalled()
        f.advance(5000); f.poll.mockResolvedValueOnce({ state: 'slow_down' })
        await expect(f.complete()).resolves.toEqual({ state: 'pending' })
        f.advance(10_000)
        await expect(f.complete()).resolves.toEqual({ state: 'pending' }); expect(f.poll).toHaveBeenCalledTimes(1)
        await expect(f.complete('complete-b')).resolves.toMatchObject({ state: 'connected' })
        expect(f.poll).toHaveBeenCalledTimes(2)
    })

    it('expires waiting custody and never reuses an expired code or auto-starts a new attempt', async () => {
        const f = await fixture(); await f.startAttempt(); f.advance(121_000)
        await expect(f.complete()).resolves.toEqual({ state: 'failed' })
        expect((await f.store.read(initialApproval))?.value.deviceCode).toBeUndefined()
        await expect(f.custody.fallback.start({ ...target, requestId: 'retry' }, f.signal)).resolves.toEqual({ state: 'failed' })
        expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
    })

    it.each(['stop', 'revoke', 'edit', 'shutdown'] as const)('refuses late token publication after %s', async action => {
        const f = await fixture(); await f.startAttempt(); f.advance(5000)
        const result = deferred<unknown>(), entered = deferred<void>()
        f.poll.mockImplementationOnce(async () => { entered.resolve(); return result.promise })
        const completion = f.complete(); await entered.promise
        if (action === 'stop') await f.custody.stop(initialApproval)
        if (action === 'revoke') f.revoked.abort()
        if (action === 'edit') f.lifecycle.disconnect(target.owner, target.name)
        if (action === 'shutdown') f.shutdown.abort()
        result.resolve(authorized)
        await expect(completion).resolves.toEqual({ state: 'unknown' })
        expect(f.writeCredential).not.toHaveBeenCalled()
        expect((await f.store.read(initialApproval))?.value.deviceCode).toBeUndefined()
    })

    it('checks credential generation again after a provider wait', async () => {
        const f = await fixture(); await f.startAttempt(); f.advance(5000)
        f.poll.mockImplementationOnce(async () => { f.change({ ...initialApproval, credentialGeneration: 'generation-b' }); return authorized })
        await expect(f.complete()).resolves.toEqual({ state: 'unknown' })
        expect(f.writeCredential).not.toHaveBeenCalled()
    })

    it('retains an ambiguous credential commit and never retries its poll/write', async () => {
        const f = await fixture(); await f.startAttempt(); f.advance(5000)
        f.writeCredential.mockRejectedValueOnce(new Error('lost database acknowledgement'))
        await expect(f.complete()).resolves.toEqual({ state: 'unknown' })
        await expect(f.make().fallback.complete({ ...target, requestId: 'new-call' }, f.signal)).resolves.toEqual({ state: 'unknown' })
        expect(f.writeCredential).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1)
    })

    it('Stop clears only this waiting registration and preserves a sibling', async () => {
        const f = await fixture(); await f.startAttempt()
        const sibling = { ...initialApproval, registrationId: 'sibling', name: 'sibling' }
        const saved = (await f.store.read(initialApproval))!
        await f.store.create(sibling, { ...saved.value, approval: sibling }, () => {})
        await f.custody.stop(initialApproval)
        expect((await f.store.read(initialApproval))?.value).toMatchObject({ phase: 'cancelled', deviceCode: undefined })
        expect((await f.store.read(sibling))?.value.deviceCode).toBe('FIXTURE_DEVICE_SECRET')
    })

    it('cannot decrypt copied ciphertext under another workspace/registration', async () => {
        const f = await fixture(); await f.startAttempt()
        const other = { ...initialApproval, workspaceId: 'other' }
        await f.db.execute({ sql: 'INSERT INTO desktop_mcp_device_custody SELECT ?,agent_id,?,version,sealed FROM desktop_mcp_device_custody WHERE workspace_id=?', args: [other.workspaceId, slotOf(other), initialApproval.workspaceId] })
        await expect(f.store.read(other)).rejects.toThrow('damaged or unavailable')
    })

    it('counts lifetime from reservation rather than extending it after a delayed start', async () => {
        const f = await fixture()
        f.start.mockImplementationOnce(async () => { f.advance(121_000); return started })
        await expect(f.startAttempt()).resolves.toEqual({ state: 'unknown' })
        expect((await f.store.read(initialApproval))?.value.deviceCode).toBeUndefined()
    })

    it('rejects a changed payload reusing the same effect ID', async () => {
        const f = await fixture(); await f.startAttempt(); f.advance(5000)
        await expect(f.custody.fallback.complete(target, f.signal)).rejects.toThrow('request identity changed')
        expect(f.poll).not.toHaveBeenCalled()
    })

    it('a lost poll acknowledgement does not repeat even with another explicit call ID', async () => {
        const f = await fixture(); await f.startAttempt(); f.advance(5000)
        f.poll.mockRejectedValueOnce(new Error('authorization response lost'))
        await expect(f.complete()).resolves.toEqual({ state: 'unknown' })
        await expect(f.make().fallback.complete({ ...target, requestId: 'another' }, f.signal)).resolves.toEqual({ state: 'unknown' })
        expect(f.poll).toHaveBeenCalledTimes(1); expect(f.writeCredential).not.toHaveBeenCalled()
    })

    it('oversized private responses are refused without serializing them into status', async () => {
        const f = await fixture()
        f.start.mockResolvedValueOnce({ ...started, deviceCode: 'X'.repeat(70_000) })
        const result = await f.startAttempt()
        expect(result).toEqual({ state: 'unknown' })
        expect(JSON.stringify(result)).not.toContain('XXX')
    })

    it('damaged ciphertext and missing storage remain errors rather than anonymous fresh attempts', async () => {
        const f = await fixture(); await f.startAttempt()
        await f.db.execute("UPDATE desktop_mcp_device_custody SET sealed='damaged'")
        await expect(f.complete()).rejects.toThrow('damaged or unavailable')
        expect(f.poll).not.toHaveBeenCalled()
        const g = await fixture()
        await g.db.execute('DROP TABLE desktop_mcp_device_custody')
        await expect(g.startAttempt()).rejects.toThrow()
        expect(g.start).not.toHaveBeenCalled()
    })
})
