import { expect, it, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }))
vi.mock('../auth', () => ({ authenticateDesktopRequest: mocks.authenticate, DesktopHttpError: class extends Error { constructor(readonly status: number, message: string) { super(message) } } }))
import { createDesktopMcpDeviceReviewApi } from './api'

const source = { agentId: 'coworker', sessionId: 'local-chat', runId: 'source-run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'exact-source', server: { name: 'docs', revision: 'r1', url: 'https://docs.example/mcp', displayName: 'Docs' } }
const request = (body: unknown, method = 'POST') => new Request('https://app.example/api/desktop/sessions/local-chat/mcp-sign-in', { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
beforeEach(() => { mocks.authenticate.mockReset(); mocks.authenticate.mockResolvedValue({ workspaceId: 1 }) })

it('authenticates the human endpoint before resolving any authority or parsing private input', async () => {
    const resolve = vi.fn()
    mocks.authenticate.mockRejectedValue(new Error('FIXTURE_PRIVATE_AUTH_ERROR'))
    const response = await createDesktopMcpDeviceReviewApi(resolve)(request({ action: 'review-device-method', source }), 'local-chat')
    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain('FIXTURE_')
    expect(resolve).not.toHaveBeenCalled()
})

it('rejects browser Connect, foreign sessions and injected method/token fields before resolving a service', async () => {
    const resolve = vi.fn()
    const decision = { reviewId: randomUUID(), revision: randomUUID(), decisionId: randomUUID(), operation: 'approve-device-method' }
    for (const body of [
        { action: 'connect', source },
        { action: 'review-device-method', source: { ...source, sessionId: 'foreign' } },
        { action: 'review-device-method', source, method: { clientId: 'model-claimed' } },
        { action: 'decide-device-method', source, decision: { ...decision, token: 'FIXTURE_PRIVATE' } },
    ]) {
        const response = await createDesktopMcpDeviceReviewApi(resolve)(request(body), 'local-chat')
        expect(response.status).toBe(409)
        expect(await response.text()).not.toContain('FIXTURE_')
    }
    expect(resolve).not.toHaveBeenCalled()
})

it('keeps the review response human-only and forwards an exact identity-only decision', async () => {
    const decision = { reviewId: randomUUID(), revision: randomUUID(), decisionId: randomUUID(), operation: 'approve-device-method' }
    const service = { review: vi.fn(), decide: vi.fn().mockResolvedValue({ state: 'approved', receipt: { outcome: 'approved' } }) }
    const resolve = vi.fn().mockResolvedValue(service)
    const response = await createDesktopMcpDeviceReviewApi(resolve)(request({ action: 'decide-device-method', source, decision }), 'local-chat')
    expect(service.decide).toHaveBeenCalledWith(source, decision, expect.any(AbortSignal))
    expect(await response.json()).toEqual({ review: { state: 'approved', receipt: { outcome: 'approved' } } })
    expect(service.review).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe('no-store')
})

it('returns an exact human authorization as no-store and refuses code injection or a foreign conversation', async () => {
    const body = { action: 'read-device-authorization', source, reviewId: randomUUID(), revision: randomUUID() }
    const authorization = { reviewId: body.reviewId, revision: body.revision, verificationUri: 'https://issuer.example/activate', userCode: 'HUMAN-QA', expiresAt: 200_000 }
    const service = { readAuthorization: vi.fn().mockResolvedValue(authorization) }
    const resolve = vi.fn().mockResolvedValue(service)
    const api = createDesktopMcpDeviceReviewApi(resolve)
    expect((await api(request({ ...body, userCode: 'INJECTED' }), 'local-chat')).status).toBe(409)
    expect((await api(request(body), 'foreign-chat')).status).toBe(409)
    expect(resolve).not.toHaveBeenCalled()
    const response = await api(request(body), 'local-chat')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ authorization })
    expect(service.readAuthorization).toHaveBeenCalledWith(source, body.reviewId, body.revision, expect.any(AbortSignal))
})

it('requires an exact human request ID for starting or checking the saved review', async () => {
    const ids = { reviewId: randomUUID(), revision: randomUUID(), requestId: randomUUID() }
    const operate = vi.fn().mockResolvedValue({ state: 'pending', authorization: null })
    const api = createDesktopMcpDeviceReviewApi(vi.fn().mockResolvedValue({ operate }))
    const body = { action: 'check-device-authorization', source, ...ids }
    expect((await api(request({ ...body, requestId: 'invalid' }), 'local-chat')).status).toBe(409)
    expect((await api(request({ ...body, deviceCode: 'INJECTED' }), 'local-chat')).status).toBe(409)
    expect(operate).not.toHaveBeenCalled()
    const result = await api(request(body), 'local-chat')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toEqual({ attempt: { state: 'pending', authorization: null } })
    expect(operate).toHaveBeenCalledExactlyOnceWith(source, ids.reviewId, ids.revision, ids.requestId, 'complete', expect.any(AbortSignal))
})
