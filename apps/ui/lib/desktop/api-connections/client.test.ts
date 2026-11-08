// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest'
import { createApiConnectionsClient } from './client'
import { catalogFixture, resultFixture, FIXTURE_REQUEST_ID } from './fixtures'
const routes = { catalog: () => '/api/desktop/connection-fixture', removalPlan: () => '/api/desktop/connection-fixture/removal', mutation: () => '/api/desktop/connection-fixture/write' }
test('credential mutation uses only the canonical POST DTO and never places a key in the URL', async () => {
    const catalog = catalogFixture(), input = { workspaceId: 1, requestId: FIXTURE_REQUEST_ID, connectionId: catalog.connections[1].connectionId, expectedRevision: catalog.connections[1].revision, secret: 'offline-fixture-value' }
    const transport = vi.fn<typeof fetch>(async () => Response.json(resultFixture({ kind: 'credential', input }, catalog)))
    const api = createApiConnectionsClient(routes, transport)
    await api.credential(input)
    expect(transport.mock.calls[0][0]).toBe(routes.mutation())
    const options = transport.mock.calls[0][1]!
    expect(options.method).toBe('POST'); expect(options.redirect).toBe('error')
    expect(JSON.parse(options.body as string)).toEqual(input)
})
test('secret fields in returned views, foreign acknowledgements and remote routes fail closed', async () => {
    const catalog = catalogFixture()
    const response = vi.fn<typeof fetch>(async () => Response.json({ ...catalog, connections: [{ ...catalog.connections[0], secret: 'must-not-be-returned' }] }))
    await expect(createApiConnectionsClient(routes, response).list(1)).rejects.toThrow('Could not confirm')
    response.mockClear()
    await expect(createApiConnectionsClient({ ...routes, catalog: () => 'https://remote.invalid/api/desktop/connections' }, response).list(1)).rejects.toThrow('local connection route')
    expect(response).not.toHaveBeenCalled()
    const input = { workspaceId: 1, requestId: FIXTURE_REQUEST_ID, connectionId: catalog.connections[0].connectionId, expectedRevision: catalog.connections[0].revision, name: 'Changed' }
    const foreign = resultFixture({ kind: 'rename', input }, catalog); foreign.receipt.requestId = '00000000-0000-4000-8000-000000000002'
    response.mockImplementation(async () => Response.json(foreign))
    await expect(createApiConnectionsClient(routes, response).rename(input)).rejects.toThrow('another request')
})
test('unknown error bodies are never echoed and an already cancelled request never reaches the transport', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ error: 'raw credential must not be echoed' }, { status: 500 }))
    const api = createApiConnectionsClient(routes, transport)
    await expect(api.list(1)).rejects.toThrow('Could not confirm the connection request')
    transport.mockClear(); const controller = new AbortController(); controller.abort()
    await expect(api.list(1, controller.signal)).rejects.toThrow('Could not confirm')
    expect(transport).not.toHaveBeenCalled()
})
