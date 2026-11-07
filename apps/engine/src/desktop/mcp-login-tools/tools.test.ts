import { describe, expect, it, vi } from 'vitest'
import { createDesktopMcpLoginTools } from './tools.js'
import { markMcpLoginTool, isDesktopMcpLoginTool } from './admission.js'
import { loginRequestSchema } from './contract.js'

const identity = { engineAgentId: 'engine-a', sessionId: 'chat-a', runId: 'run-a' }
const options = { toolCallId: 'call', messages: [] }
function setup() {
    const controller = new AbortController()
    const port = { authorize: vi.fn(async () => {}), call: vi.fn(async (request: { toolCallId: string }) => ({ identity, toolCallId: request.toolCallId, result: { action: 'status', servers: [] } })) }
    const tools = createDesktopMcpLoginTools(identity, controller.signal, port)
    return { controller, port, tools }
}

describe('desktop login tools and admission', () => {
    it('admits only actual owner-bound adapter instances', () => {
        const { tools } = setup()
        expect(isDesktopMcpLoginTool(tools.mcp_status, 'mcp_status', 'engine-a')).toBe(true)
        expect(isDesktopMcpLoginTool(tools.mcp_status, 'mcp_status', 'other')).toBe(false)
        expect(isDesktopMcpLoginTool({ description: 'mcp_status' }, 'mcp_status', 'engine-a')).toBe(false)
        const human = markMcpLoginTool({}, 'engine-a', 'request_mcp_sign_in')
        expect(isDesktopMcpLoginTool(human, 'request_mcp_sign_in', 'engine-a')).toBe(true)
        expect(isDesktopMcpLoginTool(human, 'mcp_login', 'engine-a')).toBe(false)
    })

    it('reports an empty trusted inventory without inventing a connection', async () => {
        const { tools, port } = setup()
        expect(await tools.mcp_status!.execute!({}, options)).toBe('No HTTPS MCP servers registered. Local MCP programs use a separate permission and status.')
        expect(port.authorize).toHaveBeenCalledTimes(2)
    })

    it('denied permission, cancellation and late identity changes refuse publication', async () => {
        const box = setup()
        box.port.authorize.mockRejectedValueOnce(new Error('grant off'))
        await expect(box.tools.mcp_status!.execute!({}, options)).rejects.toThrow('grant off')
        expect(box.port.call).not.toHaveBeenCalled()
        box.controller.abort()
        await expect(box.tools.mcp_status!.execute!({}, options)).rejects.toThrow()
        const next = setup()
        next.port.call.mockImplementationOnce(async () => ({ identity: { ...identity, sessionId: 'other-chat' }, toolCallId: 'call', result: { action: 'status', servers: [] } }))
        await expect(next.tools.mcp_status!.execute!({}, options)).rejects.toThrow('identity')
    })

    it('rejects URLs, credentials, commands and claimed approvals at the strict boundary', () => {
        for (const field of ['url', 'token', 'command', 'approved', 'revision']) {
            expect(loginRequestSchema.safeParse({ identity, toolCallId: 'call', action: 'start', name: 'linear', [field]: 'injected' }).success).toBe(false)
        }
    })
})

it('does not retry or expose raw transport errors after a lost authorization acknowledgement', async () => {
    const controller = new AbortController()
    const call = vi.fn(async () => { throw new Error('token=PRIVATE') })
    const tools = createDesktopMcpLoginTools(identity, controller.signal, { authorize: async () => {}, call })
    await expect(tools.mcp_login!.execute!({ name: 'linear' }, options)).rejects.toThrow('Do not retry authorization')
    expect(call).toHaveBeenCalledTimes(1)
})

it('stops waiting for an unresponsive adapter after parent Stop', async () => {
    const controller = new AbortController()
    const tools = createDesktopMcpLoginTools(identity, controller.signal, {
        authorize: async () => {}, call: async () => { controller.abort(); return new Promise(() => {}) },
    })
    await expect(tools.mcp_status!.execute!({}, options)).rejects.toThrow('unavailable')
})
