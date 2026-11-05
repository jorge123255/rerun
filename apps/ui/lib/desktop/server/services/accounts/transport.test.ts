import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { accountTransport, type AccountNetwork } from './transport'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '../../../../../../../packages/contracts/src/desktop-service-accounts'
import { mcpResponse } from './regression-harness'

const url = 'https://example.com/mcp'
const secret = 'fixture-header-value'

function recorded(network: AccountNetwork) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const transport = accountTransport(async (next, init) => {
        calls.push({ url: next, init })
        return network(next, init)
    })
    return { calls, transport }
}

it('sends one account header set only to its exact HTTPS endpoint', async () => {
    const { calls, transport } = recorded(mcpResponse)
    const signal = new AbortController().signal
    const result = await transport.probe({ url, headers: { 'X-Api-Key': secret, 'Content-Type': 'text/plain' }, signal })
    expect(result.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(calls.every(call => call.url === url)).toBe(true)
    const post = calls.find(call => call.init.method === 'POST')!
    const headers = post.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toContain('text/event-stream')
    expect(headers['MCP-Protocol-Version']).toBe('2025-03-26')
    expect(headers['X-Api-Key']).toBe(secret)
    expect(post.init.redirect).toBe('manual')
    expect(post.init.credentials).toBe('omit')
    expect(calls.some(call => call.init.method === 'DELETE' && call.url === url)).toBe(true)
})

it('does not follow a redirect or put a header value in the failure', async () => {
    const { calls, transport } = recorded(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal', 'X-Api-Key': secret } }))
    await expect(transport.probe({ url, headers: { 'X-Api-Key': secret }, signal: new AbortController().signal })).rejects.toThrow(M.origin)
    expect(calls.map(call => call.url)).toEqual([url])
    try {
        await transport.probe({ url, headers: { 'X-Api-Key': secret }, signal: new AbortController().signal })
    } catch (error) {
        expect((error as Error).message).toBe(M.origin)
        expect((error as Error).message).not.toContain(secret)
        expect((error as Error).message).not.toContain('evil.example')
    }
})

it('redacts a called tool result and reports cancellation without the credential', async () => {
    const { transport } = recorded(mcpResponse)
    const signal = new AbortController().signal
    const called = await transport.call({ url, headers: { Authorization: `Bearer ${secret}` }, signal, name: 'echo', arguments: {} })
    expect(JSON.stringify(called)).not.toContain(secret)
    expect(JSON.stringify(called)).toContain('[REDACTED]')
    const controller = new AbortController()
    const cancelled = accountTransport(async () => {
        controller.abort()
        throw new Error(`leaked ${secret}`)
    })
    await expect(cancelled.probe({ url, headers: { 'X-Api-Key': secret }, signal: controller.signal })).rejects.toThrow(M.cancelled)
})
