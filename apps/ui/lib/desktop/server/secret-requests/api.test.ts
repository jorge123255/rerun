import { expect, test, vi } from 'vitest'
import { createDesktopSecretRequestApi, type DesktopSecretRequestApiPorts } from './api'

const source = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const input = { operation: 'recover', requestId: 'request', attemptId: 'attempt', expectedRevision: 'revision', source }
const acknowledgement = () => new Response('data: [DONE]\n\n', { headers: { 'x-secret-request-id': 'request', 'x-run-id': 'continuation', 'x-session-id': 'chat' } })

test('metadata-only recovery is a distinct API operation and rejects credential values', async () => {
    const ports: DesktopSecretRequestApiPorts = { read: vi.fn(), decide: vi.fn(), recover: vi.fn(async () => acknowledgement()) }
    const api = createDesktopSecretRequestApi(ports)
    const request = (body: unknown) => new Request('http://localhost/api/secret-requests', { method: 'POST', body: JSON.stringify(body) })
    const response = await api.POST(request(input), 'chat')
    expect(response.headers.get('x-secret-request-id')).toBe('request')
    expect(ports.recover).toHaveBeenCalledWith('chat', input, expect.any(AbortSignal))
    expect(ports.decide).not.toHaveBeenCalled()
    await expect(api.POST(request({ ...input, values: { EXAMPLE_API_KEY: 'must not enter recovery' } }), 'chat')).rejects.toMatchObject({ status: 400 })
    expect(ports.recover).toHaveBeenCalledTimes(1)
})
