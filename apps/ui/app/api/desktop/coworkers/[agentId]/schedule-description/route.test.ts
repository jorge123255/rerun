import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = { dataRoot: '/test-data', workspaceId: 1, launchNonce: 'nonce', engine: { origin: 'http://127.0.0.1:4000', apiKey: 'test-key' } }
const mocks = vi.hoisted(() => ({ findAgent: vi.fn(), getAgent: vi.fn() }))
vi.mock('@/lib/desktop/server/http', () => ({ desktopRoute: (_request: Request, work: (value: typeof runtime) => Promise<Response>) => work(runtime) }))
vi.mock('@/lib/desktop/server/store', () => ({ findDesktopAgent: mocks.findAgent }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('@/lib/desktop/server/settings', () => ({ engineOf: (value: typeof runtime) => ({ baseUrl: value.engine.origin, apiKey: value.engine.apiKey }) }))
vi.mock('@/lib/engine/client', () => ({ getAgent: mocks.getAgent }))

import { POST } from './route'

const input = { description: 'weekdays at 8', nowIso: '2026-11-09T12:00:00-06:00', timezone: 'America/Chicago', connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' }
const request = () => new Request('http://localhost/api/desktop/coworkers/alice/schedule-description', { method: 'POST', body: JSON.stringify(input) })
const params = Promise.resolve({ agentId: 'alice' })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    vi.clearAllMocks()
    mocks.findAgent.mockResolvedValue({ id: 'alice', engineAgentId: 'engine-alice' })
    mocks.getAgent.mockResolvedValue({ id: 'engine-alice' })
    fetchMock = vi.fn(async () => Response.json({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5' } }))
    vi.stubGlobal('fetch', fetchMock)
})

describe('desktop schedule-description route', () => {
    it('forwards exact identity, body, credential and cancellation to the scoped engine operation', async () => {
        const response = await POST(request(), { params })

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5' } })
        expect(mocks.findAgent).toHaveBeenCalledWith(expect.anything(), 'alice')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('http://127.0.0.1:4000/agents/engine-alice/schedules/describe')
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) })
        expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' })
        expect(JSON.parse(String(init.body))).toEqual(input)
    })

    it.each([403, 409, 503])('maps engine denial/unavailable HTTP %s without a fake preview', async status => {
        fetchMock.mockResolvedValueOnce(Response.json({ error: 'denied' }, { status }))
        const response = await POST(request(), { params })

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({ status: 'unavailable' })
    })

    it('maps a malformed engine response to invalid', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ status: 'ok', value: null, extra: true }))
        const response = await POST(request(), { params })

        await expect(response.json()).resolves.toMatchObject({ status: 'invalid' })
    })

    it('reports an unreachable engine as unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new Error('offline'))
        const response = await POST(request(), { params })

        await expect(response.json()).resolves.toMatchObject({ status: 'unavailable' })
    })

    it('propagates caller abort', async () => {
        const controller = new AbortController()
        const aborted = new Request('http://localhost/api/desktop/coworkers/alice/schedule-description', { method: 'POST', body: JSON.stringify(input), signal: controller.signal })
        fetchMock.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted') })

        await expect(POST(aborted, { params })).rejects.toThrow('aborted')
    })
})
