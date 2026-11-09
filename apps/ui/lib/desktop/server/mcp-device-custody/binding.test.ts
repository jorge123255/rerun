import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import { bindApprovedMcpDeviceCustody } from './binding'
import { desktopMcpDeviceCustodySchema } from './store'
import type { DeviceApproval } from './model'
import { remoteMcpStore, remoteMcpOAuthSchema } from '../mcp/store'

const databases: Client[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
async function fixture() {
    const db = createClient({ url: ':memory:' }); databases.push(db)
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('agent');
        CREATE TABLE desktop_remote_mcp(id TEXT,transport TEXT,agent_id TEXT,name TEXT,url TEXT,revision TEXT,bearer TEXT, PRIMARY KEY(agent_id,name));
        INSERT INTO desktop_remote_mcp VALUES('registration','http','agent','docs','https://docs.example/mcp','r1',NULL);
        ${remoteMcpOAuthSchema} ${desktopMcpDeviceCustodySchema}`)
    const key = () => Buffer.alloc(32, 29), store = remoteMcpStore(db, key)
    const identity = { engineAgentId: 'engine', sessionId: 'chat', runId: 'run' }
    const approval: DeviceApproval = {
        approvalId: 'human-approval', workspaceId: 'workspace', owner: 'agent', engineAgentId: 'engine', sessionId: 'chat', registrationId: 'registration',
        name: 'docs', revision: 'r1', credentialGeneration: 'g1', approvedUntil: 2_000_000,
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
    const start = vi.fn(async () => ({ deviceCode: 'OFFLINE_DEVICE_SECRET', verificationUri: approval.method.verificationUri, interval: 5, expiresIn: 120 }))
    const poll = vi.fn(async () => ({ state: 'authorized', token: { accessToken: 'OFFLINE_ACCESS_SECRET', refreshToken: 'OFFLINE_REFRESH_SECRET', tokenType: 'Bearer', expiresIn: 600 } }))
    const options = { db, key, workspaceId: 'workspace', service,
        now: () => time,
        watchOwner: () => { const captured = epoch; return () => { if (epoch !== captured) throw new Error('owner changed') } },
        approvedMethod: vi.fn(async () => ({ approval, signal: revoked.signal, check() { if (!current) throw new Error('revoked') } })),
        broker: { start, poll },
    }
    const binding = bindApprovedMcpDeviceCustody(options), signal = new AbortController().signal
    const request = { identity, toolCallId: 'start-id', action: 'start', name: 'docs' }
    return { db, store, approval, options, service, binding, signal, start, poll, request,
        advance: () => { time += 5000 }, stopRun: () => { current = false }, switchOwner: () => { epoch++ },
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

it.each(['workspaceId', 'registrationId'] as const)('rejects a foreign %s before broker activation', async field => {
    const f = await fixture(); f.approval[field] = 'foreign'
    await expect(f.binding.dispatch(f.request, f.signal)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled()
    f.binding.dispose()
})

it('cannot reuse browser Connect as device authority and cannot advance an inactive run', async () => {
    const f = await fixture()
    f.options.approvedMethod.mockResolvedValueOnce(null as never)
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
