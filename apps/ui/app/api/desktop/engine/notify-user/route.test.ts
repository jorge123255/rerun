import { beforeEach, expect, test, vi } from 'vitest'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { acceptDesktopUserNotification } from '@/lib/desktop/server/user-notifications'
import { POST } from './route'

vi.mock('@/lib/desktop/server/auth', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/desktop/server/auth')>(),
    authenticateDesktopEngineRequest: vi.fn(async () => ({ workspaceId: 7, dataRoot: '/synthetic' })),
}))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: vi.fn(async () => ({ kind: 'db' })) }))
vi.mock('@/lib/desktop/server/user-notifications', () => ({
    acceptDesktopUserNotification: vi.fn(),
    readDesktopNotifyGrant: vi.fn(),
    desktopNotifyRunIsCurrent: vi.fn(),
}))

const payload = { notificationId: 'notify:agent-a:session-a:run-a:call-a', eventKey: 'notify-user:agent-a:session-a:run-a:call-a', toolCallId: 'call-a', agentId: 'agent-a', agentName: 'Ada', sessionId: 'session-a', runId: 'run-a', message: 'Review this', metadata: null }
const request = (body: unknown) => new Request('http://127.0.0.1/api/desktop/engine/notify-user', { method: 'POST', body: JSON.stringify(body) })
const receipt = { ...payload, attemptId: '11111111-1111-4111-8111-111111111111', metadata: null, status: 'unknown', nativeStatus: 'unknown', createdAt: '2026-11-09T00:00:00.000Z' }

beforeEach(() => {
    vi.mocked(authenticateDesktopEngineRequest).mockClear()
    vi.mocked(acceptDesktopUserNotification).mockReset()
})

test('returns the engine authentication refusal', async () => {
    vi.mocked(authenticateDesktopEngineRequest).mockRejectedValueOnce(new DesktopHttpError(401, 'Unauthorized'))
    expect((await POST(request(payload))).status).toBe(401)
    expect(acceptDesktopUserNotification).not.toHaveBeenCalled()
})

test('refuses an invalid receipt identity and a body over the engine limit', async () => {
    expect((await POST(request({ ...payload, runId: 'x'.repeat(129) }))).status).toBe(400)
    expect((await POST(request({ ...payload, metadata: { oversized: 'x'.repeat(200_000) } }))).status).toBe(413)
    expect(acceptDesktopUserNotification).not.toHaveBeenCalled()
})

test('returns the stored receipt unchanged and does not invent native success', async () => {
    vi.mocked(acceptDesktopUserNotification).mockResolvedValueOnce(receipt as never)
    const response = await POST(request(payload))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(receipt)
    vi.mocked(acceptDesktopUserNotification).mockRejectedValueOnce(new DesktopHttpError(409, 'This notification is no longer part of the active run.'))
    expect((await POST(request(payload))).status).toBe(409)
})
