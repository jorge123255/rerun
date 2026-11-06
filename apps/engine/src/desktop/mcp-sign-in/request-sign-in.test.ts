import { expect, test, vi } from 'vitest'
import { createDesktopMcpSignInTool } from './request-sign-in'
import type { DesktopMcpSignInSource } from '@rerun/contracts'

const source: DesktopMcpSignInSource = {
    agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint',
    server: { name: 'linear', revision: 'revision-1', url: 'https://linear.example/mcp', displayName: 'Linear', host: 'linear.example', icon: null },
}

test('delivers only a currently registered supported server and ends the request turn', async () => {
    const authority = { authorize: vi.fn(async () => {}), deliver: vi.fn(async () => source) }
    const tools = createDesktopMcpSignInTool(authority)
    const result = await tools.request_mcp_sign_in!.execute!({ name: 'linear', reason: 'Use Linear.' }, { toolCallId: 'tool', abortSignal: undefined })
    expect(result).toMatchObject({ status: 'delivered' })
    expect(authority.deliver).toHaveBeenCalledWith({ name: 'linear', reason: 'Use Linear.' }, { toolCallId: 'tool', abortSignal: undefined })
})

test('forged identity, unsupported registration and revoked permission fail before publication', async () => {
    const authority = { authorize: vi.fn(async () => { throw new Error('not granted') }), deliver: vi.fn(async () => source) }
    const tools = createDesktopMcpSignInTool(authority)
    await expect(tools.request_mcp_sign_in!.execute!({ name: 'linear', url: 'https://attacker.example' }, { toolCallId: 'tool', abortSignal: undefined })).rejects.toThrow()
    expect(authority.deliver).not.toHaveBeenCalled()
})

test('a callback source for another tool call or changed registration is refused', async () => {
    const authority = { authorize: vi.fn(async () => {}), deliver: vi.fn(async () => ({ ...source, toolCallId: 'other' })) }
    const tools = createDesktopMcpSignInTool(authority)
    await expect(tools.request_mcp_sign_in!.execute!({ name: 'linear' }, { toolCallId: 'tool', abortSignal: undefined })).rejects.toThrow('source')
})
