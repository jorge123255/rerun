import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import { bindApprovedMcpDeviceCustody } from './binding'
import type { DeviceApprovalLease } from './custody'
import { createEncryptedDeviceCustodyStore, desktopMcpDeviceCustodySchema } from './store'
import { deviceApprovalSchema, type DeviceApproval } from './model'
import { remoteMcpStore, remoteMcpOAuthSchema } from '../mcp/store'
import { credentialGenerationToken } from '../mcp/credential-generation'
import { desktopMcpSignInDecisionSchema } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'

const databases: Client[] = []
const roots: string[] = []
afterEach(async () => {
    vi.restoreAllMocks()
    databases.splice(0).forEach(db => db.close())
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-device-custody-'))
    roots.push(root)
    const open = () => { const db = createClient({ url: `file:${join(root, 'app.db')}` }); databases.push(db); return db }
    const db = open()
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('agent');
        CREATE TABLE desktop_remote_mcp(id TEXT,transport TEXT,agent_id TEXT,name TEXT,url TEXT,revision TEXT,bearer TEXT, PRIMARY KEY(agent_id,name));
        INSERT INTO desktop_remote_mcp VALUES('registration','http','agent','docs','https://docs.example/mcp','r1',NULL);
        ${remoteMcpOAuthSchema} ${desktopMcpDeviceCustodySchema}`)
    const key = () => Buffer.alloc(32, 29), store = remoteMcpStore(db, key)
    const initial = (await store.credentialState('agent', 'docs'))!
    const identity = { engineAgentId: 'engine', sessionId: 'chat', runId: 'run' }
    const approval: DeviceApproval = {
        approvalId: 'human-approval', workspaceId: 'workspace', owner: 'agent', engineAgentId: 'engine', sessionId: 'chat', registrationId: 'registration',
        name: 'docs', revision: 'r1', credentialGeneration: credentialGenerationToken(key(), 'agent', 'docs', initial, initial.sealed), approvedUntil: 2_000_000,
        method: { kind: 'device-code-link-v1', resource: 'https://docs.example/mcp', issuer: 'https://auth.example/', deviceEndpoint: 'https://auth.example/device',
            tokenEndpoint: 'https://auth.example/token', verificationUri: 'https://auth.example/activate', clientId: 'fixture-client' },
    }
    const shutdown = new AbortController(), revoked = new AbortController()
    let current = true, epoch = 0, time = 1_000_000
    const service = {
        store, shutdownSignal: shutdown.signal,
        authorizeRun: vi.fn(async (input: typeof identity) => {
            if (!current || JSON.stringify(input) !== JSON.stringify(identity)) throw new Error('inactive run')
            return 'agent'
        }),
        runtime: { probe: vi.fn(async () => ({ tools: [{ name: 'search' }] })) },
    }
    const start = vi.fn(async (): Promise<unknown> => ({ deviceCode: 'OFFLINE_DEVICE_SECRET', verificationUri: approval.method.verificationUri, interval: 5, expiresIn: 120 }))
    const poll = vi.fn(async (): Promise<unknown> => ({ state: 'authorized', token: { accessToken: 'OFFLINE_ACCESS_SECRET', refreshToken: 'OFFLINE_REFRESH_SECRET', tokenType: 'Bearer', expiresIn: 600 } }))
    const options = { db, key, workspaceId: 'workspace', service,
        now: () => time,
        watchOwner: () => { const captured = epoch; return () => { if (epoch !== captured) throw new Error('owner changed') } },
        approvedMethod: vi.fn(async (): Promise<DeviceApprovalLease | null> => ({ approval, signal: revoked.signal, check() { if (!current) throw new Error('revoked') } })),
        broker: { start, poll },
    }
    const binding = bindApprovedMcpDeviceCustody(options), signal = new AbortController().signal
    const request = { identity, toolCallId: 'start-id', action: 'start', name: 'docs' }
    return { db, open, store, approval, options, service, binding, signal, start, poll, request, revoked,
        custodyStore: createEncryptedDeviceCustodyStore(db, key),
        target: { owner: 'agent', identity, name: 'docs', revision: 'r1', url: 'https://docs.example/mcp' },
        advance: (ms = 5000) => { time += ms }, stopRun: () => { current = false }, switchOwner: () => { epoch++ },
    }
}

it('binds existing encrypted MCP credentials and lets only the existing backend probe publish tool names', async () => {
    const f = await fixture()
    await expect(f.binding.dispatch(f.request, f.signal)).resolves.toMatchObject({ result: { view: { state: 'waiting' } } })
    f.advance()
    const response = await f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'complete-id' }, f.signal)
    expect(response).toMatchObject({ result: { view: { state: 'connected', tools: ['docs_search'] } } })
    expect(JSON.stringify(response)).not.toMatch(/OFFLINE_|accessToken|refreshToken|engineAgentId.*OFFLINE/)
    expect(JSON.stringify((await f.db.execute('SELECT * FROM desktop_remote_mcp_oauth')).rows)).not.toContain('OFFLINE_ACCESS_SECRET')
    expect(await f.store.readOAuth('agent', 'docs')).toMatchObject({ accessToken: 'OFFLINE_ACCESS_SECRET', resource: 'https://docs.example/mcp' })
    expect(f.service.runtime.probe).toHaveBeenCalledTimes(1)
    f.binding.dispose()
})

it('a credential write with failed probe never announces a successful connection', async () => {
    const f = await fixture(); await f.binding.dispatch(f.request, f.signal); f.advance()
    f.service.runtime.probe.mockRejectedValueOnce(new Error('OFFLINE_PRIVATE_ERROR'))
    const response = await f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'complete-id' }, f.signal)
    expect(response).toMatchObject({ result: { view: { state: 'failed' } } })
    expect(JSON.stringify(response)).not.toContain('OFFLINE_')
    expect(await f.store.readOAuth('agent', 'docs')).not.toBeNull()
    f.binding.dispose()
})

it('preserves a newer credential written by another connection during a device poll', async () => {
    const f = await fixture()
    await f.binding.dispatch(f.request, f.signal)
    f.advance()
    const writer = remoteMcpStore(f.open(), f.options.key)
    const newer = { accessToken: 'newer-approval', resource: f.target.url, expiresAt: Date.now() + 60_000,
        issuer: f.approval.method.issuer, tokenEndpoint: f.approval.method.tokenEndpoint, clientId: 'different-client' }
    f.poll.mockImplementationOnce(async () => {
        await writer.writeOAuth('agent', 'docs', f.target.revision, newer, f.signal)
        return { state: 'authorized', token: { accessToken: 'late-device-approval', tokenType: 'Bearer', expiresIn: 600 } }
    })
    const response = await f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'complete-after-replacement' }, f.signal)
    expect(await f.store.readOAuth('agent', 'docs')).toEqual(newer)
    expect(response).toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(f.service.runtime.probe).not.toHaveBeenCalled()
    f.binding.dispose()
})

it('refuses a stale approved generation before reserving or starting device authorization', async () => {
    const f = await fixture()
    const writer = remoteMcpStore(f.open(), f.options.key)
    await writer.writeOAuth('agent', 'docs', f.target.revision, {
        accessToken: 'newer-approval', resource: f.target.url, expiresAt: Date.now() + 60_000,
        issuer: f.approval.method.issuer, tokenEndpoint: f.approval.method.tokenEndpoint, clientId: 'different-client',
    }, f.signal)
    await expect(f.binding.dispatch(f.request, f.signal)).resolves.toMatchObject({ result: { view: { state: 'approval_required' } } })
    expect(f.start).not.toHaveBeenCalled()
    expect(await f.custodyStore.read(f.approval)).toBeNull()
    f.binding.dispose()
})

it('rolls back a device credential when SQLite refuses its terminal custody receipt', async () => {
    const f = await fixture()
    await f.binding.dispatch(f.request, f.signal)
    f.advance()
    await f.db.executeMultiple(`CREATE TRIGGER fixture_reject_device_receipt BEFORE UPDATE ON desktop_mcp_device_custody
        WHEN NEW.version=5 AND EXISTS(SELECT 1 FROM desktop_remote_mcp_oauth)
        BEGIN SELECT RAISE(ABORT,'fixture terminal receipt unavailable'); END;`)
    const response = await f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'refused-receipt' }, f.signal)
    expect(await remoteMcpStore(f.open(), f.options.key).readOAuth('agent', 'docs')).toBeNull()
    expect(response).toMatchObject({ result: { view: { state: 'unknown' } } })
    expect((await f.custodyStore.read(f.approval))?.value).toMatchObject({ phase: 'unknown' })
    expect(f.service.runtime.probe).not.toHaveBeenCalled()
    f.binding.dispose()
})

it.each(['workspaceId', 'registrationId', 'owner', 'engineAgentId', 'sessionId', 'name', 'revision'] as const)('rejects a foreign %s before broker activation', async field => {
    const f = await fixture(); f.approval[field] = 'foreign'
    await expect(f.binding.dispatch(f.request, f.signal)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
    f.binding.dispose()
})

it('cannot reuse browser Connect as device authority and cannot advance an inactive run', async () => {
    const f = await fixture()
    f.options.approvedMethod.mockResolvedValueOnce(null)
    await expect(f.binding.dispatch(f.request, f.signal)).resolves.toMatchObject({ result: { view: { state: 'approval_required' } } })
    f.stopRun()
    await expect(f.binding.dispatch(f.request, f.signal)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled()
    f.binding.dispose()
})

it('a configured bearer remains in its own custody and excludes fallback', async () => {
    const f = await fixture()
    await f.store.save('agent', { name: 'docs', url: 'https://docs.example/mcp', revision: 'r1', bearer: 'OFFLINE_MANUAL_BEARER' })
    await expect(f.binding.dispatch(f.request, f.signal)).resolves.toMatchObject({ result: { view: { state: 'unsupported' } } })
    expect(f.start).not.toHaveBeenCalled()
    expect((await f.store.read('agent', 'docs')).bearer).toBe('OFFLINE_MANUAL_BEARER')
    f.binding.dispose()
})

it('passes only the exact approved method to the fake broker and keeps private bytes out of responses, status, disk and logs', async () => {
    const f = await fixture()
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const waiting = await f.binding.dispatch(f.request, f.signal)
    expect(f.options.approvedMethod).toHaveBeenCalledWith(f.target, expect.any(AbortSignal))
    expect(f.start.mock.calls).toEqual([[f.approval.method, expect.any(AbortSignal)]])
    const pending = await f.db.execute('SELECT * FROM desktop_mcp_device_custody')
    expect(JSON.stringify(pending.rows)).not.toContain('OFFLINE_')
    f.advance()
    const connected = await f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'complete-id' }, f.signal)
    expect(f.poll.mock.calls).toEqual([[f.approval.method, 'OFFLINE_DEVICE_SECRET', expect.any(AbortSignal)]])
    const status = await f.binding.dispatch({ identity: f.request.identity, action: 'status', toolCallId: 'status-id' }, f.signal)
    const inspected = await f.binding.inspect(f.target, f.signal)
    expect(connected).toMatchObject({ result: { view: { state: 'connected', tools: ['docs_search'] } } })
    expect(status).toMatchObject({ result: { servers: [{ status: 'connected', tools: ['docs_search'] }] } })
    expect(inspected).toEqual({ state: 'pending' })
    const publicBytes = JSON.stringify([waiting, connected, status, inspected])
    expect(publicBytes).not.toMatch(/OFFLINE_|deviceCode|accessToken|refreshToken|credentialGeneration|approvalId|clientId|tokenEndpoint/)
    expect(JSON.stringify((await f.db.execute('SELECT * FROM desktop_remote_mcp_oauth')).rows)).not.toContain('OFFLINE_')
    expect(logs.every(log => log.mock.calls.length === 0)).toBe(true)
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1)
    f.binding.dispose()
})

it('the current human Connect decision cannot supply device-method authority', async () => {
    const f = await fixture()
    const decision = desktopMcpSignInDecisionSchema.parse({ operation: 'connect', requestId: 'request', attemptId: 'attempt', expectedRevision: 'card-r1',
        source: { agentId: 'agent', sessionId: 'local-chat', runId: 'source-run', sourceMessageId: 'message', toolCallId: 'source-call', fingerprint: 'source-body',
            server: { name: 'docs', revision: 'r1', url: f.target.url, displayName: 'Docs' } },
    })
    expect(deviceApprovalSchema.safeParse(decision).success).toBe(false)
    expect(desktopMcpSignInDecisionSchema.safeParse({ ...decision, method: f.approval.method }).success).toBe(false)
    f.options.approvedMethod.mockResolvedValue({ approval: decision, signal: f.signal, check() {} })
    await expect(f.binding.dispatch(f.request, f.signal)).rejects.toThrow('MCP device custody data is unavailable or unsupported')
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
    expect((await f.db.execute('SELECT * FROM desktop_mcp_device_custody')).rows).toEqual([])
    f.binding.dispose()
})

it('leaves an exact approval gated when no broker is bound, without reserving custody', async () => {
    const f = await fixture(); f.binding.dispose()
    const unbound = bindApprovedMcpDeviceCustody({ ...f.options, broker: undefined })
    await expect(unbound.dispatch(f.request, f.signal)).resolves.toMatchObject({ result: { view: { state: 'unsupported' } } })
    expect((await f.db.execute('SELECT * FROM desktop_mcp_device_custody')).rows).toEqual([])
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
    unbound.dispose()
})

it.each([
    { kind: 'browser-oauth' },
    { resource: 'https://other.example/mcp' },
    { deviceEndpoint: 'https://other.example/device' },
    { verificationUri: 'https://auth.example/activate?code=OFFLINE_SECRET' },
    { clientSecret: 'OFFLINE_SECRET' },
])('refuses unsupported or mismatched method shapes before any broker effect: %j', async change => {
    const f = await fixture()
    f.options.approvedMethod.mockResolvedValue({ approval: { ...f.approval, method: { ...f.approval.method, ...change } }, signal: f.signal, check() {} })
    await expect(f.binding.dispatch(f.request, f.signal)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
    expect((await f.db.execute('SELECT * FROM desktop_mcp_device_custody')).rows).toEqual([])
    f.binding.dispose()
})

it('requires an unexpired approval before reservation and refuses an expired waiting attempt without polling', async () => {
    const f = await fixture()
    f.approval.approvedUntil = 1_000_000
    await expect(f.binding.dispatch(f.request, f.signal)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled()
    f.approval.approvedUntil = 2_000_000
    await f.binding.dispatch(f.request, f.signal)
    f.advance(120_000)
    const saved = await f.custodyStore.read(f.approval)
    await expect(f.binding.inspect(f.target, f.signal)).resolves.toEqual({ state: 'failed' })
    expect(await f.custodyStore.read(f.approval)).toEqual(saved)
    await expect(f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'expired-complete' }, f.signal)).resolves.toMatchObject({ result: { view: { state: 'failed' } } })
    expect((await f.custodyStore.read(f.approval))?.value).toMatchObject({ phase: 'expired' })
    expect((await f.custodyStore.read(f.approval))?.value.deviceCode).toBeUndefined()
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
    f.binding.dispose()
})

it('Stop retires the exact waiting attempt across recreation without starting or polling it again', async () => {
    const f = await fixture()
    await f.binding.dispatch(f.request, f.signal)
    await f.binding.stop(f.approval)
    expect((await f.custodyStore.read(f.approval))?.value).toMatchObject({ phase: 'cancelled' })
    expect((await f.custodyStore.read(f.approval))?.value.deviceCode).toBeUndefined()
    f.binding.dispose()
    const restored = bindApprovedMcpDeviceCustody(f.options)
    for (const action of ['start', 'complete']) {
        await expect(restored.dispatch({ ...f.request, action, toolCallId: `after-stop-${action}` }, f.signal)).resolves.toMatchObject({ result: { view: { state: 'failed' } } })
    }
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
    expect(await f.store.readOAuth('agent', 'docs')).toBeNull()
    restored.dispose()
})

it.each(['stop', 'revoke', 'expiry'] as const)('does not publish a late fake-broker token after %s', async action => {
    const f = await fixture()
    await f.binding.dispatch(f.request, f.signal); f.advance()
    let entered!: () => void, finish!: (value: unknown) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const result = new Promise<unknown>(resolve => { finish = resolve })
    f.poll.mockImplementationOnce(async () => { entered(); return result })
    const request = { ...f.request, action: 'complete', toolCallId: 'late-complete' }
    const completion = f.binding.dispatch(request, f.signal)
    await started
    if (action === 'stop') await f.binding.stop(f.approval)
    if (action === 'revoke') f.revoked.abort()
    if (action === 'expiry') f.advance(120_000)
    finish({ state: 'authorized', token: { accessToken: 'OFFLINE_LATE_TOKEN', tokenType: 'Bearer', expiresIn: 600 } })
    await expect(completion).resolves.toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(await f.store.readOAuth('agent', 'docs')).toBeNull()
    expect((await f.custodyStore.read(f.approval))?.value).toMatchObject({ phase: 'unknown' })
    expect((await f.custodyStore.read(f.approval))?.value.deviceCode).toBeUndefined()
    f.binding.dispose()
    const restored = bindApprovedMcpDeviceCustody(f.options)
    if (action === 'revoke') await expect(restored.dispatch(request, f.signal)).rejects.toThrow()
    else await expect(restored.dispatch({ ...request, toolCallId: 'new-complete' }, f.signal)).resolves.toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).toHaveBeenCalledTimes(1)
    expect(f.service.runtime.probe).not.toHaveBeenCalled()
    restored.dispose()
})

it.each(['clientId', 'scope', 'credentialGeneration'] as const)('rechecks the exact approved %s after a broker wait', async field => {
    const f = await fixture()
    await f.binding.dispatch(f.request, f.signal); f.advance()
    f.poll.mockImplementationOnce(async () => {
        if (field === 'credentialGeneration') f.approval.credentialGeneration = 'g2'
        else f.approval.method[field] = 'changed'
        return { state: 'authorized', token: { accessToken: 'OFFLINE_LATE_TOKEN', tokenType: 'Bearer', expiresIn: 600 } }
    })
    await expect(f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'changed-method' }, f.signal)).resolves.toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(await f.store.readOAuth('agent', 'docs')).toBeNull()
    expect(f.service.runtime.probe).not.toHaveBeenCalled()
    expect(f.poll).toHaveBeenCalledTimes(1)
    f.binding.dispose()
})

it('rejects an edited registration before the waiting attempt can reach the broker again', async () => {
    const f = await fixture()
    await f.binding.dispatch(f.request, f.signal); f.advance()
    await f.store.save('agent', { name: 'docs', revision: f.target.revision, url: f.target.url })
    expect((await f.store.list('agent'))[0]?.revision).not.toBe(f.target.revision)
    await expect(f.binding.dispatch({ ...f.request, action: 'complete', toolCallId: 'edited-registration' }, f.signal)).rejects.toThrow()
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.poll).not.toHaveBeenCalled()
    expect(await f.store.readOAuth('agent', 'docs')).toBeNull()
    f.binding.dispose()
})

it.each([
    ['start', 'invalid'], ['start', 'rejected'], ['complete', 'invalid'], ['complete', 'rejected'],
] as const)('retains an unknown %s/%s response across recreation and never replays an ambiguous effect', async (action, responseKind) => {
    const f = await fixture()
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    if (action === 'complete') { await f.binding.dispatch(f.request, f.signal); f.advance() }
    const broker = action === 'start' ? f.start : f.poll
    if (responseKind === 'invalid') broker.mockResolvedValueOnce({ state: 'unknown', diagnostic: 'OFFLINE_PRIVATE_RESPONSE', deviceCode: 'OFFLINE_DEVICE_SECRET' })
    else broker.mockRejectedValueOnce(new Error('OFFLINE_PRIVATE_PROVIDER_ERROR'))
    const request = { ...f.request, action, toolCallId: `unknown-${action}` }
    const response = await f.binding.dispatch(request, f.signal)
    expect(response).toMatchObject({ result: { view: { state: 'unknown' } } })
    expect(JSON.stringify(response)).not.toContain('OFFLINE_')
    expect((await f.custodyStore.read(f.approval))?.value.deviceCode).toBeUndefined()
    f.binding.dispose()
    const restored = bindApprovedMcpDeviceCustody(f.options)
    const saved = await f.custodyStore.read(f.approval)
    await expect(restored.inspect(f.target, f.signal)).resolves.toEqual({ state: 'unknown' })
    expect(await f.custodyStore.read(f.approval)).toEqual(saved)
    for (const replay of [request, { ...request, toolCallId: 'new-id' }]) {
        await expect(restored.dispatch(replay, f.signal)).resolves.toMatchObject({ result: { view: { state: 'unknown' } } })
    }
    expect(broker).toHaveBeenCalledTimes(1)
    expect(await f.store.readOAuth('agent', 'docs')).toBeNull()
    expect(f.service.runtime.probe).not.toHaveBeenCalled()
    expect(logs.every(log => log.mock.calls.length === 0)).toBe(true)
    restored.dispose()
})
