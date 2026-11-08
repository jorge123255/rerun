import { beforeEach, expect, test, vi } from 'vitest'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { POST } from './route'

vi.mock('@/lib/desktop/server/auth', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/desktop/server/auth')>(),
    authenticateDesktopEngineRequest: vi.fn(async () => ({})),
}))

const payload = { notificationId: 'notification-1', eventKey: 'event-key-1', agentId: 'agent-a', sessionId: 'session-a', runId: 'run-a', message: 'Review this', metadata: null }
const request = (body: unknown) => new Request('http://127.0.0.1/api/desktop/engine/notify-user', {
    method: 'POST',
    body: JSON.stringify(body),
})

beforeEach(() => vi.mocked(authenticateDesktopEngineRequest).mockClear())

test('returns the engine authentication refusal', async () => {
    vi.mocked(authenticateDesktopEngineRequest).mockRejectedValueOnce(new DesktopHttpError(401, 'Unauthorized'))
    expect((await POST(request(payload))).status).toBe(401)
})

test('refuses an invalid receipt identity and a body over the engine limit', async () => {
    expect((await POST(request({ ...payload, runId: 'x'.repeat(129) }))).status).toBe(400)
    expect((await POST(request({ ...payload, metadata: { oversized: 'x'.repeat(200_000) } }))).status).toBe(413)
})

test('returns an unknown delivery receipt for a valid request', async () => {
    const response = await POST(request(payload))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ...payload, status: 'unknown', nativeStatus: 'unknown' })
})
