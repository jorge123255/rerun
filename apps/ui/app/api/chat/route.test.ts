import { getAgentChatTarget, getExistingSession } from '@/app/api/_services/chat.service'
import * as engine from '@/lib/engine/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceContext: vi.fn().mockResolvedValue({ userId: 'me', authUser: { app_metadata: {}, user_metadata: {} } }) }))
vi.mock('@/app/api/_services/notification-audience.service', () => ({ recordSessionParticipant: vi.fn(), recordSessionRead: vi.fn() }))
vi.mock('@/app/api/_services/chat.service', () => ({
    getAgentChatTarget: vi.fn(),
    getExistingSession: vi.fn(),
    createSessionRow: vi.fn(),
    updateSessionStatus: vi.fn(),
}))
vi.mock('@/lib/ai/generate-title', () => ({ generateSessionTitle: vi.fn().mockResolvedValue('Title') }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ chat: vi.fn(), reconnectRun: vi.fn() }))

const busy = () => Response.json({ runId: 'run-1', startedAt: null }, { status: 409 })
const streaming = (runId: string) => new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-run-id': runId, 'x-session-id': 'engine-session' } })

function request(body: Record<string, unknown>) {
    return new Request('https://rerun.test/api/chat', { method: 'POST', body: JSON.stringify({ agentId: 'agent', sessionId: 'session', text: 'ship it', ...body }) })
}

// The route sleeps between retries; without fake timers the queued cases would take 25 seconds.
async function settle(response: Promise<Response>): Promise<Response> {
    await vi.runAllTimersAsync()
    return response
}

describe('POST /api/chat', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        vi.mocked(getAgentChatTarget).mockResolvedValue({ engineAgentId: 'engine-agent', conn: { baseUrl: 'https://engine.test', apiKey: null } })
        vi.mocked(getExistingSession).mockResolvedValue({ sessionId: 'session', engineSessionId: 'engine-session' })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('hands a queued message back rather than tailing the run holding the conversation', async () => {
        vi.mocked(engine.chat).mockImplementation(async () => busy())

        const response = await settle(POST(request({ queued: true })))

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: 'run_in_flight', runId: 'run-1' })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
        expect(vi.mocked(engine.chat).mock.calls.length).toBeGreaterThan(1)
    })

    it('sends a queued message as soon as the engine releases the session', async () => {
        vi.mocked(engine.chat).mockImplementationOnce(async () => busy()).mockImplementationOnce(async () => streaming('run-2'))

        const response = await settle(POST(request({ queued: true })))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('run-2')
        expect(engine.chat).toHaveBeenCalledTimes(2)
    })

    it('still tails the run in flight for a message that was not queued', async () => {
        vi.mocked(engine.chat).mockImplementation(async () => busy())
        vi.mocked(engine.reconnectRun).mockResolvedValue(streaming('run-1'))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('run-1')
        expect(engine.chat).toHaveBeenCalledTimes(1)
        expect(engine.reconnectRun).toHaveBeenCalledOnce()
    })
})
