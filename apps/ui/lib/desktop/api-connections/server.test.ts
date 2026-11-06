import { afterEach, expect, test, vi } from 'vitest'
import { catalogFixture, resultFixture, FIXTURE_REQUEST_ID } from './fixtures'
const boundary = vi.hoisted(() => ({ workspaceId: 1, nextWorkspace: 1, calls: [] as { path: string; init: RequestInit }[] }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/desktop/server/auth', () => {
    class DesktopHttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
    return { DesktopHttpError, authenticateDesktopRequest: async () => ({ workspaceId: boundary.workspaceId,
        launchNonce: 'offline-fixture', buildId: 'offline-fixture', engine: { origin: 'http://127.0.0.1:7000', apiKey: 'offline-fixture-only' } }) }
})
vi.mock('@/lib/engine/client', () => ({ request: vi.fn(async (_connection: unknown, path: string, init: RequestInit, parse: (value: unknown) => unknown) => {
    boundary.calls.push({ path, init })
    const input = JSON.parse(init.body as string)
    boundary.workspaceId = boundary.nextWorkspace
    return parse(resultFixture({ kind: 'credential', input }, catalogFixture()))
}) }))
import { createApiConnectionsRouteHandlers } from './server'
afterEach(() => { boundary.workspaceId = 1; boundary.nextWorkspace = 1; boundary.calls = []; vi.clearAllMocks() })
const routes = { catalog: () => '/desktop/api-connections', removalPlan: () => '/desktop/api-connections/review', mutation: (_workspace: number, kind: string) => `/desktop/api-connections/mutations/${kind}` }
const credential = () => ({ workspaceId: 1, requestId: FIXTURE_REQUEST_ID, connectionId: catalogFixture().connections[0].connectionId, expectedRevision: catalogFixture().connections[0].revision, secret: 'offline-ui-fixture-only' })
test('authenticated bridge forwards an exact F credential DTO, using no redirects and no public secret result', async () => {
    const input = credential(), response = await createApiConnectionsRouteHandlers(routes).mutation(new Request('http://127.0.0.1/api/desktop/fixture', { method: 'POST', body: JSON.stringify(input) }), '1', 'credential')
    expect(response.status).toBe(200)
    expect(boundary.calls).toHaveLength(1); expect(boundary.calls[0].init.redirect).toBe('error')
    expect(JSON.parse(boundary.calls[0].init.body as string)).toEqual(input)
    expect(await response.text()).not.toContain(input.secret)
})
test('workspace changes after a committed engine result refuse publication without dispatching another write', async () => {
    boundary.nextWorkspace = 2
    const response = await createApiConnectionsRouteHandlers(routes).mutation(new Request('http://127.0.0.1/api/desktop/fixture', { method: 'POST', body: JSON.stringify(credential()) }), '1', 'credential')
    expect(response.status).toBe(409); expect(boundary.calls).toHaveLength(1)
    expect(await response.text()).not.toContain(credential().secret)
})
test('selection without the root authority is unavailable and never invokes the engine', async () => {
    const connection = catalogFixture().connections[0]
    const input = { workspaceId: 1, requestId: FIXTURE_REQUEST_ID, connectionId: connection.connectionId,
        expectedRevision: connection.revision, model: connection.models[0], source: 'workspace', runId: 'fixture-selection', sessionId: 'fixture-settings' }
    const response = await createApiConnectionsRouteHandlers(routes).mutation(new Request('http://127.0.0.1/api/desktop/fixture', { method: 'POST', body: JSON.stringify(input) }), '1', 'select')
    expect(response.status).toBe(503); expect(boundary.calls).toHaveLength(0)
})
