import { expect, test, vi } from 'vitest'
import { createDesktopSecretRequestTool } from './request-secret'

const source = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const fields = [{ key: 'EXAMPLE_API_KEY', label: 'Example API key' }]

test('delivers one validated request and ends the turn without exposing credentials or substitution instructions', async () => {
    const authority = { authorize: vi.fn(async () => {}), deliver: vi.fn(async () => source) }
    const tools = createDesktopSecretRequestTool(authority)
    const result = await tools.request_secret!.execute!({ secrets: fields, reason: 'Use the API.' }, { toolCallId: 'tool', abortSignal: undefined, messages: [] })
    expect(result).toMatchObject({ status: 'delivered' })
    expect(authority.authorize).toHaveBeenCalledWith({ toolCallId: 'tool', abortSignal: undefined })
    expect(authority.deliver).toHaveBeenCalledWith({ fields, reason: 'Use the API.' }, { toolCallId: 'tool', abortSignal: undefined })
    expect(JSON.stringify(result)).not.toContain('MCP')
    expect(JSON.stringify(result)).not.toContain('shell')
})

test('revoked, disabled, deleting or delegated-child authority fails closed before delivery', async () => {
    const authority = { authorize: vi.fn(async () => { throw new Error('request_secret is not granted for this run') }), deliver: vi.fn(async () => source) }
    const tools = createDesktopSecretRequestTool(authority)
    await expect(tools.request_secret!.execute!({ secrets: fields }, { toolCallId: 'tool', abortSignal: undefined, messages: [] })).rejects.toThrow('not granted')
    expect(authority.deliver).not.toHaveBeenCalled()
})

test('invalid or duplicate/reserved fields never reach delivery', async () => {
    const authority = { authorize: vi.fn(async () => {}), deliver: vi.fn(async () => source) }
    const tools = createDesktopSecretRequestTool(authority)
    await expect(tools.request_secret!.execute!({ secrets: [{ key: 'ENGINE_API_KEY', label: 'Runtime' }] }, { toolCallId: 'tool', abortSignal: undefined, messages: [] })).rejects.toThrow()
    await expect(tools.request_secret!.execute!({ secrets: [...fields, fields[0]] }, { toolCallId: 'tool', abortSignal: undefined, messages: [] })).rejects.toThrow()
    expect(authority.deliver).not.toHaveBeenCalled()
})

test('a foreign delivery source is rejected instead of creating an acknowledged request', async () => {
    const authority = { authorize: vi.fn(async () => {}), deliver: vi.fn(async () => ({ ...source, toolCallId: 'another-call' })) }
    const tools = createDesktopSecretRequestTool(authority)
    await expect(tools.request_secret!.execute!({ secrets: fields }, { toolCallId: 'tool', abortSignal: undefined, messages: [] })).rejects.toThrow('source')
})

test('model null optional fields are normalized before canonical delivery', async () => {
    const authority = { authorize: vi.fn(async () => {}), deliver: vi.fn(async () => source) }
    const tools = createDesktopSecretRequestTool(authority)
    await tools.request_secret!.execute!({ secrets: [{ ...fields[0], help: null, docsUrl: null }], reason: null }, { toolCallId: 'tool', messages: [] })
    expect(authority.deliver).toHaveBeenCalledWith({ fields }, { toolCallId: 'tool', abortSignal: undefined })
})
