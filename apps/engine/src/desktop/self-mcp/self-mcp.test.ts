import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunContext } from '../../runtime/context.js'
import type { AgentConfig } from '../../agents/types.js'
import { selfMcpFingerprint } from './fingerprint.js'
import { setEnv } from '../../config/env.js'

// The engine -> UI propose bridge is a plain loopback fetch. These tests never
// open a network connection: fetch is stubbed and every refusal asserts it was
// never called.
//
// Root executes these regression sources after integrating the desktop grant and binding.
const root = mkdtempSync(join(tmpdir(), 'rerun-mac-self-mcp-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_HUB_BASE_URL = 'http://127.0.0.1:39876/'
process.env.RERUN_API_KEY = 'test-key'

const { writeAgentConfig } = await import('../../agents/config-write.js')

const id = 'self-mcp-alpha'
const signal = new AbortController().signal

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
    ({
        name: id,
        description: 'Tester',
        enabled: true,
        selfImprovement: { enabled: true, allowToolInstall: true, allowSoulEdit: true, autoMemory: true },
        tools: { desktopToolGrants: {} },
        ...overrides,
    }) as unknown as AgentConfig

const granted = (): AgentConfig => baseConfig({ tools: { desktopToolGrants: { selfMcpRegister: true } } } as Partial<AgentConfig>)

const ctxFor = (config: AgentConfig, extra: Partial<RunContext> = {}): RunContext =>
    ({ agent: { id, config }, sessionId: 'session-1', runId: 'run-1', abortSignal: signal, logger: { warn: () => {} } as unknown as RunContext['logger'], ...extra }) as unknown as RunContext

const { desktopSelfMcpTools } = await import('./index.js')
const toolsOf = (ctx: RunContext) => desktopSelfMcpTools(ctx)
const call = (tool: { execute?: (args: unknown, opts: unknown) => Promise<string> }, args: unknown) => tool.execute!(args, { messages: [], toolCallId: 'call-1' })

const input = () => ({
    name: 'linear',
    transport: 'http',
    command: undefined,
    args: [],
    url: 'https://mcp.linear.app',
    headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
})

const fetchMock = vi.fn<typeof fetch>()
beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock)
    await mkdir(join(root, 'agents', id), { recursive: true })
})
afterAll(async () => {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
})

describe('desktopSelfMcpTools — admission gates', () => {
    it('exposes no tool when the default-off self-MCP grant is absent', () => {
        expect(Object.keys(toolsOf(ctxFor(baseConfig())))).toEqual([])
    })

    it('exposes no tool when the Improve-itself master is off', () => {
        const config = granted()
        config.selfImprovement.enabled = false
        expect(Object.keys(toolsOf(ctxFor(config)))).toEqual([])
    })

    it('exposes no tool when the coworker is disabled', () => {
        const config = granted()
        config.enabled = false
        expect(Object.keys(toolsOf(ctxFor(config)))).toEqual([])
    })

    it('requires an active, cancellable run once the grant is on', () => {
        expect(() => toolsOf(ctxFor(granted(), { runId: undefined }))).toThrow(/active, cancellable run/)
        expect(() => toolsOf(ctxFor(granted(), { abortSignal: undefined }))).toThrow(/active, cancellable run/)
    })

    it('exposes mcp_register to a granted, master-on coworker', () => {
        expect(Object.keys(toolsOf(ctxFor(granted())))).toEqual(['mcp_register'])
    })
})

describe('mcp_register — strict nonsecret validation before any effect', () => {
    it('refuses the reserved engine name without calling the bridge', async () => {
        const tools = toolsOf(ctxFor(granted()))
        const out = await call(tools.mcp_register!, { ...input(), name: 'rerun' })
        expect(out).toContain('"rerun" is reserved for the engine\'s own tools')
        expect(out).toContain('Nothing was proposed or saved.')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses an invalid server name without calling the bridge', async () => {
        const tools = toolsOf(ctxFor(granted()))
        const out = await call(tools.mcp_register!, { ...input(), name: 'bad name' })
        expect(out).toContain('is invalid: use 1-64 characters')
        expect(out).toContain('Nothing was proposed or saved.')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses inline credentials in headers without calling the bridge', async () => {
        const tools = toolsOf(ctxFor(granted()))
        const out = await call(tools.mcp_register!, { ...input(), headers: { Authorization: 'Bearer sk-ant-0123456789abcdef' } })
        expect(out).toContain('never an inline secret')
        expect(out).toContain('Nothing was proposed or saved.')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses credential-bearing urls without calling the bridge', async () => {
        const tools = toolsOf(ctxFor(granted()))
        const out = await call(tools.mcp_register!, { ...input(), url: 'https://user:pass@mcp.example.com' })
        expect(out).toContain('without credentials, query or fragment')
        expect(out).toContain('Nothing was proposed or saved.')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses a stdio proposal with no command without calling the bridge', async () => {
        const tools = toolsOf(ctxFor(granted()))
        const out = await call(tools.mcp_register!, { ...input(), transport: 'stdio', command: undefined, url: undefined })
        expect(out).toContain('needs a command for stdio')
        expect(out).toContain('Nothing was proposed or saved.')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses an aborted call before validating', async () => {
        const aborted = new AbortController()
        aborted.abort(new Error('Stop requested'))
        const tools = toolsOf(ctxFor(granted(), { abortSignal: aborted.signal }))
        await expect(call(tools.mcp_register!, input())).rejects.toThrow('Stop requested')
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

// Post-wiring execute-path cases (see header note): these require the grants
// catalog entry so the fresh `requireDesktopToolGrant` read parses.
describe('mcp_register — propose bridge', () => {
    beforeEach(() => {
        fetchMock.mockReset()
    })

    const proposeReply = (outcome: 'proposed' | 'reconciled' | 'conflict' | 'refused', message: string, fingerprint = 'a'.repeat(64)) =>
        new Response(JSON.stringify({ outcome, message, ...(outcome === 'proposed' || outcome === 'reconciled' ? { proposal: { id: 'prop-1', revision: 1, agentId: id, launchEpoch: 'epoch-1', identity: { engineAgentId: id, sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1' }, fingerprint, input: input(), transport: 'http', configRevision: 1, status: 'pending', createdAt: new Date().toISOString() } } : {}) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })

    it('proposes a clean server and reports the waiting review card, opening no server connection', async () => {
        await writeAgentConfig(id, granted())
        const tools = toolsOf(ctxFor(granted()))
        fetchMock.mockResolvedValueOnce(proposeReply('proposed', 'ok'))
        const out = await call(tools.mcp_register!, input())
        expect(out).toContain('Proposed MCP server "linear" (http)')
        expect(out).toContain('A review card is waiting')
        expect(out).not.toContain('Nothing was proposed or saved.')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toContain('/api/desktop/internal/self-mcp')
        const body = JSON.parse(String(init?.body))
        expect(body.action).toBe('propose')
        expect(body.identity).toMatchObject({ engineAgentId: id, sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1' })
        expect(body.fingerprint).toBe(selfMcpFingerprint({ name: 'linear', transport: 'http', command: undefined, args: [], url: 'https://mcp.linear.app', headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' }, env: {} }))
        expect(body.input).toMatchObject({ name: 'linear', url: 'https://mcp.linear.app', headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' } })
    })

    it('reconciles the identical invocation into the existing proposal', async () => {
        await writeAgentConfig(id, granted())
        const tools = toolsOf(ctxFor(granted()))
        fetchMock.mockResolvedValueOnce(proposeReply('reconciled', 'ok'))
        const out = await call(tools.mcp_register!, input())
        expect(out).toContain('already under review')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('refuses a changed body under the same identity and proposes nothing', async () => {
        await writeAgentConfig(id, granted())
        const tools = toolsOf(ctxFor(granted()))
        fetchMock.mockResolvedValueOnce(proposeReply('conflict', 'a different proposal already exists'))
        const out = await call(tools.mcp_register!, input())
        expect(out).toContain('a different proposal from this call already exists')
        expect(out).toContain('Nothing was proposed or saved.')
    })

    it('refuses when the UI service cannot admit the proposal', async () => {
        await writeAgentConfig(id, granted())
        const tools = toolsOf(ctxFor(granted()))
        fetchMock.mockResolvedValueOnce(proposeReply('refused', 'the coworker is being deleted'))
        const out = await call(tools.mcp_register!, input())
        expect(out).toContain('the coworker is being deleted')
        expect(out).toContain('Nothing was proposed or saved.')
    })

    it('refuses a stale granted call after the grant is revoked', async () => {
        await writeAgentConfig(id, granted())
        const tools = toolsOf(ctxFor(granted()))
        await writeAgentConfig(id, baseConfig())
        await expect(call(tools.mcp_register!, input())).rejects.toThrow('This tool is turned off for this coworker.')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses when the proposal bridge is unavailable (no hub configured)', async () => {
        await writeAgentConfig(id, granted())
        const tools = toolsOf(ctxFor(granted()))
        setEnv({ RERUN_HUB_BASE_URL: '' })
        try {
            await expect(call(tools.mcp_register!, input())).rejects.toThrow('MCP review service is unavailable')
        } finally {
            setEnv({ RERUN_HUB_BASE_URL: 'http://127.0.0.1:39876/' })
        }
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
