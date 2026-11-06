import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopRemoteMachinesClient, RemoteMachineRequestError, REMOTE_MACHINES_ROUTE, type RemoteMachineActorSeed } from './remote-machines-client'

const fetchMock = vi.fn()
afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
})

const actorSeed: RemoteMachineActorSeed = {
    installId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 1,
    launchNonce: '22222222-2222-4222-8222-222222222222',
}
const connection = {
    connectionId: '33333333-3333-4333-8333-333333333333',
    revision: '44444444-4444-4444-8444-444444444444',
    workspaceId: 1,
    address: 'https://machine.example',
    identity: { protocolVersion: 1, machineId: '55555555-5555-4555-8555-555555555555', workspaceId: 1 },
    credentialConfigured: true,
    removable: true,
    health: { state: 'connected', checkedAt: '2026-11-06T00:00:00.000Z', commit: 'abc1234', activeAgents: 3, reason: null },
} as const
const snapshot = {
    version: 1,
    actor: { ...actorSeed, rendererEpoch: '77777777-7777-4777-8777-777777777777' },
    revision: connection.revision,
    connection,
    selected: true,
    openReceipt: null,
}
const ok = (overrides: Record<string, unknown> = {}) => ({ ok: true, snapshot: { ...snapshot, ...overrides }, receipt: null })

function bodyOf(callIndex = 0): Record<string, unknown> {
    return JSON.parse(String(fetchMock.mock.calls[callIndex][1]?.body)) as Record<string, unknown>
}

describe('createDesktopRemoteMachinesClient', () => {
    it('reads the snapshot with the panel actor and a fresh request id', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValueOnce(Response.json(ok())))
        const client = createDesktopRemoteMachinesClient(actorSeed)
        const result = await client.read()
        expect(result.connection?.address).toBe('https://machine.example')
        expect(String(fetchMock.mock.calls[0][0])).toBe(REMOTE_MACHINES_ROUTE)
        const body = bodyOf()
        expect(body.action).toBe('read')
        expect(body.actor).toMatchObject(actorSeed)
        expect(String(body.actor.rendererEpoch)).toMatch(/^[0-9a-f-]{36}$/)
        expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/)
        client.dispose()
    })

    it('pairs with a fresh connection id against the unconfigured revision', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValueOnce(Response.json(ok())))
        const client = createDesktopRemoteMachinesClient(actorSeed)
        await client.pair('https://machine.example', 'engine-key-1234567890123456')
        const body = bodyOf()
        expect(body.action).toBe('pair')
        expect(body.expectedRevision).toBe('unconfigured')
        expect(String(body.connectionId)).toMatch(/^[0-9a-f-]{36}$/)
        expect(body.address).toBe('https://machine.example')
        expect(body.apiKey).toBe('engine-key-1234567890123456')
        client.dispose()
    })

    it('replaces, selects and removes against the exact connection revision; remove confirms', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValue(Response.json(ok())))
        const client = createDesktopRemoteMachinesClient(actorSeed)
        await client.replace(connection.connectionId, connection.revision, 'https://next.example', 'engine-key-1234567890123456')
        await client.select(connection.connectionId, connection.revision)
        await client.remove(connection.connectionId, connection.revision)
        const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
        expect(bodies[0]).toMatchObject({ action: 'replace', connectionId: connection.connectionId, expectedRevision: connection.revision, address: 'https://next.example' })
        expect(bodies[1]).toMatchObject({ action: 'select', connectionId: connection.connectionId, expectedRevision: connection.revision })
        expect(bodies[2]).toMatchObject({ action: 'remove', connectionId: connection.connectionId, expectedRevision: connection.revision, confirmation: 'Remove' })
        client.dispose()
    })

    it('surfaces a refusal with its code and the durable receipt', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValueOnce(Response.json({ ok: false, code: 'stale', message: 'The saved server changed in another owner.', receipt: null })))
        const client = createDesktopRemoteMachinesClient(actorSeed)
        const error = await client.read().catch(cause => cause)
        expect(error).toBeInstanceOf(RemoteMachineRequestError)
        expect((error as RemoteMachineRequestError).code).toBe('stale')
        expect((error as RemoteMachineRequestError).message).toBe('The saved server changed in another owner.')
        client.dispose()
    })

    it('retries a lost mutation with the exact same request identity', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValueOnce(Response.json({ ok: false, code: 'uncertain', message: 'Unknown', receipt: null })).mockResolvedValueOnce(Response.json(ok())))
        const client = createDesktopRemoteMachinesClient(actorSeed)
        await expect(client.pair('https://machine.example', 'engine-key-1234567890123456')).rejects.toThrow(RemoteMachineRequestError)
        const first = bodyOf()
        await client.retry(String(first.requestId))
        const second = bodyOf(1)
        expect(second.requestId).toBe(first.requestId)
        expect(second.action).toBe('pair')
        expect(second.address).toBe('https://machine.example')
        client.dispose()
    })

    it('refuses work after dispose and maps transport failures to the network code', async () => {
        vi.stubGlobal('fetch', fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')))
        const client = createDesktopRemoteMachinesClient(actorSeed)
        await expect(client.read()).rejects.toMatchObject({ code: 'network' })
        client.dispose()
        await expect(client.read()).rejects.toMatchObject({ code: 'cancelled' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
