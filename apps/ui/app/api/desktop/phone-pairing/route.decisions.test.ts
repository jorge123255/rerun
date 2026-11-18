import { beforeEach, describe, expect, it, vi } from 'vitest'

// The phone route's answer and decision branches: what reaches the Mac's own question and approval
// paths, and what is refused before it gets there.
const mocks = vi.hoisted(() => ({
    readDesktopApproval: vi.fn(), answerDesktopApproval: vi.fn(), readDesktopQuestion: vi.fn(), answerDesktopQuestion: vi.fn(), startDesktopChat: vi.fn(), getRun: vi.fn(),
}))
vi.mock('@/lib/desktop/server/http', () => ({ desktopRoute: async (_request: Request, handler: (runtime: unknown) => Promise<Response>) => {
    try { return await handler({ dataRoot: '/tmp/none' }) } catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { status?: number }).status ?? 500 }) }
} }))
vi.mock('@/lib/desktop/server/auth', () => ({ DesktopHttpError: class extends Error { constructor(readonly status: number, message: string) { super(message) } } }))
vi.mock('@/lib/desktop/server/approvals', () => ({ readDesktopApproval: mocks.readDesktopApproval, answerDesktopApproval: mocks.answerDesktopApproval }))
vi.mock('@/lib/desktop/server/questions', () => ({ readDesktopQuestion: mocks.readDesktopQuestion, answerDesktopQuestion: mocks.answerDesktopQuestion }))
vi.mock('@/lib/desktop/server/engine', () => ({ readDesktopHistory: vi.fn(), startDesktopChat: mocks.startDesktopChat, startDesktopPhoneConversation: vi.fn() }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: vi.fn(async () => ({})) }))
vi.mock('@/lib/desktop/server/store', () => ({ findDesktopAgent: vi.fn(async () => ({ id: 'ada', engineAgentId: 'engine-ada' })), findDesktopSession: vi.fn(async () => ({ id: 'chat-1', agentId: 'ada', engineSessionId: 'engine-chat' })), listDesktopAgents: vi.fn(), listDesktopSessions: vi.fn() }))
vi.mock('@/lib/desktop/server/settings', () => ({ engineOf: vi.fn(() => ({})) }))
vi.mock('@/lib/desktop/server/phone-chat-pending', () => ({ readPhonePending: vi.fn() }))
vi.mock('@/lib/desktop/server/phone-reply', () => ({ phoneReplyStream: vi.fn() }))
vi.mock('@/lib/desktop/server/secret-requests/lifecycle', () => ({ withDesktopSecretSessionTransition: vi.fn() }))
vi.mock('@/lib/desktop/server/thread-views', () => ({ desktopThreadViews: vi.fn() }))
vi.mock('@/lib/desktop/server/views', () => ({ desktopSessionView: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ cancelRun: vi.fn(), EngineRequestError: class extends Error {}, getRun: mocks.getRun, reconnectRun: vi.fn() }))

import { POST } from './route'

const runId = '4ce8e801-9bbd-4c6e-8221-2e326471724c'
const post = (body: unknown, agentId = 'ada') => POST(new Request(`http://127.0.0.1/api/desktop/phone-pairing?agentId=${agentId}&chatId=chat-1`, { method: 'POST', body: JSON.stringify(body) }))
const accepted = () => new Response('data: [DONE]\n\n', { headers: { 'x-run-id': runId } })
const pendingApproval = { id: 'a'.repeat(64), messageId: 'm1', toolCallId: 'call-9', approvals: [{ action: 'Email the invoice', detail: 'Total 120.00' }, { action: 'Archive it' }] }

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.readDesktopApproval.mockResolvedValue({ approval: pendingApproval })
    mocks.answerDesktopApproval.mockImplementation(async () => accepted())
    mocks.readDesktopQuestion.mockResolvedValue({ question: null })
})

describe('a decision sent from a paired phone', () => {
    it('goes through the Mac card\'s own path, against the approval the Mac saved', async () => {
        const response = await post({ runId, approval: { toolCallId: 'call-9', decisions: [{ decision: 'approved' }, { decision: 'declined', note: 'Keep it' }] } })
        expect(response.status).toBe(202)
        expect(await response.json()).toEqual({ runId })
        expect(mocks.answerDesktopApproval).toHaveBeenCalledTimes(1)
        expect(mocks.answerDesktopApproval.mock.calls[0].slice(1)).toEqual(['chat-1', { approvalId: pendingApproval.id, requestId: runId, decisions: [{ decision: 'approved' }, { decision: 'declined', note: 'Keep it' }] }])
        expect(mocks.startDesktopChat).not.toHaveBeenCalled()
    })

    it('checks the chat owner before reading a setup question or approval', async () => {
        for (const body of [
            { runId, answer: { toolCallId: 'call-1', answers: [['Pear']] } },
            { runId, approval: { toolCallId: 'call-9', decisions: [{ decision: 'approved' }, { decision: 'declined' }] } },
        ]) expect((await post(body, 'different-coworker')).status).toBe(404)
        expect(mocks.readDesktopQuestion).not.toHaveBeenCalled()
        expect(mocks.readDesktopApproval).not.toHaveBeenCalled()
        expect(mocks.answerDesktopQuestion).not.toHaveBeenCalled()
        expect(mocks.answerDesktopApproval).not.toHaveBeenCalled()
    })

    it('is refused when it is for another card, or does not decide every action', async () => {
        for (const approval of [{ toolCallId: 'call-other', decisions: [{ decision: 'approved' }, { decision: 'approved' }] }, { toolCallId: 'call-9', decisions: [{ decision: 'approved' }] }]) {
            expect((await post({ runId, approval })).status).toBe(409)
        }
        expect(mocks.answerDesktopApproval).not.toHaveBeenCalled()
    })

    it('is refused when nothing waits and no such run was started, and is never taken as a message', async () => {
        mocks.readDesktopApproval.mockResolvedValue({ approval: null })
        mocks.getRun.mockRejectedValue(new Error('no such run'))
        expect((await post({ runId, approval: { toolCallId: 'call-9', decisions: [{ decision: 'approved' }, { decision: 'approved' }] } })).status).toBe(409)
        // A repeat of a decision the Mac already took is confirmed by its run.
        mocks.getRun.mockResolvedValue({ id: runId, sessionId: 'engine-chat', agentId: 'engine-ada', status: 'running' })
        expect((await post({ runId, approval: { toolCallId: 'call-9', decisions: [{ decision: 'approved' }, { decision: 'approved' }] } })).status).toBe(202)
        expect(mocks.answerDesktopApproval).not.toHaveBeenCalled()
        expect(mocks.startDesktopChat).not.toHaveBeenCalled()
    })

    it('is refused when it carries anything the phone has no say in', async () => {
        for (const body of [
            { runId, approval: { toolCallId: 'call-9', decisions: [{ decision: 'approved' }, { decision: 'approved' }], approvalId: 'b'.repeat(64) } },
            { runId, approval: { toolCallId: 'call-9', decisions: [{ decision: 'approved', action: 'Delete everything' }, { decision: 'approved' }] } },
            { runId, approval: { toolCallId: 'call-9', decisions: [] } },
            { runId, text: 'approve', approval: { toolCallId: 'call-9', decisions: [{ decision: 'approved' }, { decision: 'approved' }] } },
        ]) expect((await post(body)).status).toBe(400)
        expect(mocks.answerDesktopApproval).not.toHaveBeenCalled()
        expect(mocks.startDesktopChat).not.toHaveBeenCalled()
    })
})

describe('an answer sent from a paired phone', () => {
    it('is recorded against the question the Mac saved', async () => {
        mocks.readDesktopQuestion.mockResolvedValue({ question: { id: 'q'.repeat(64), toolCallId: 'call-1', questions: [{ question: 'Which fruit?', options: [] }] } })
        mocks.answerDesktopQuestion.mockImplementation(async () => accepted())
        expect((await post({ runId, answer: { toolCallId: 'call-1', answers: [['Pear']] } })).status).toBe(202)
        expect(mocks.answerDesktopQuestion.mock.calls[0].slice(1)).toEqual(['chat-1', { action: 'answer', questionId: 'q'.repeat(64), requestId: runId, answers: [['Pear']] }])
        expect((await post({ runId, answer: { toolCallId: 'call-2', answers: [['Pear']] } })).status).toBe(409)
        expect(mocks.answerDesktopQuestion).toHaveBeenCalledTimes(1)
    })
})
