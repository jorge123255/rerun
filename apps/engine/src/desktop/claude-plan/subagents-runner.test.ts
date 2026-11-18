// The actual bundled CLI and Agent SDK talk exclusively to a scripted Messages API
// on one loopback port. A second Seatbelt rule denies every other destination.
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamText } from 'ai'
import { createClaudeCode, createCustomMcpServer } from 'ai-sdk-provider-claude-code'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { clearCachedEnvForTests } from '../../config/env.js'
import { desktopClaudeRuntime } from './runtime.js'
import { desktopClaudeSubagents } from './subagents.js'
import { CLAUDE_HARNESS_ENV } from '../../agents/providers.js'

const HELPER_PRIVATE = 'offline-child-private-result'
const bridge = 'mcp__rerun__memory_search'
const deniedBridge = 'mcp__rerun__fixture_ungranted'
type Action = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

function modelResponse(res: ServerResponse, id: number, model: string, block: Action) {
    const usage = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const message = { id: 'msg_test_' + id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage }
    const parts = [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } },
        { type: 'content_block_delta', index: 0, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage },
        { type: 'message_stop' },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const part of parts) res.write('event: ' + part.type + '\ndata: ' + JSON.stringify(part) + '\n\n')
    res.end()
}

async function runFixture(stopDuringChild: boolean) {
    const require = createRequire(import.meta.url)
    const sdkRequire = createRequire(require.resolve('ai-sdk-provider-claude-code'))
    const sdkPath = sdkRequire.resolve('@anthropic-ai/claude-agent-sdk')
    const binary = await realpath(createRequire(sdkPath).resolve('@anthropic-ai/claude-agent-sdk-darwin-' + process.arch + '/claude'))
    const data = await realpath(await mkdtemp(join(tmpdir(), 'rerun-claude-subagents-')))
    const controller = new AbortController()
    let requests = 0, parentTurns = 0, childTurns = 0, admittedCalls = 0, ungrantedCalls = 0
    let sawRefusal = false, parentGotResult = false, workerPid: number | undefined
    const chunks: Array<Record<string, unknown>> = []
    let messages: unknown = [], finalText = ''
    const advertised: string[][] = []
    const server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/messages' || ++requests > 7) { res.writeHead(404).end(); return }
        let data = ''
        for await (const chunk of req) data += chunk
        const body = JSON.parse(data)
        const isChild = JSON.stringify(body.system).includes('Complete the task assigned by your parent coworker')
        let block: Action
        if (isChild) {
            advertised.push(body.tools.map((entry: { name: string }) => entry.name))
            ++childTurns
            if (stopDuringChild) { controller.abort(); return }
            if (childTurns === 1) block = { type: 'tool_use', id: 'child-ungranted', name: deniedBridge, input: {} }
            else if (childTurns === 2) {
                sawRefusal = body.messages.some((m: { content: unknown }) => Array.isArray(m.content) && m.content.some((part: { tool_use_id: string; is_error: boolean }) => part.tool_use_id === 'child-ungranted' && part.is_error === true))
                block = { type: 'tool_use', id: 'child-granted', name: bridge, input: {} }
            } else block = { type: 'text', text: HELPER_PRIVATE }
        } else if (parentTurns++ === 0) {
            block = { type: 'tool_use', id: 'parent-helper', name: 'Agent', input: { description: 'Fixture work', prompt: 'Read the fixture.', subagent_type: 'rerun-helper', run_in_background: false } }
        } else {
            parentGotResult = JSON.stringify(body.messages).includes(HELPER_PRIVATE)
            block = { type: 'text', text: 'Parent complete' }
        }
        modelResponse(res, requests, body.model, block)
    })
    let runtime: ReturnType<typeof desktopClaudeRuntime> | undefined
    const deadline = setTimeout(() => controller.abort(), 25_000)
    try {
        await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Loopback model fixture did not start')
        const sandbox = join(data, 'runner.sb')
        const production = await readFile(new URL('../../../../../scripts/desktop/claude-runner.sb', import.meta.url), 'utf8')
        await writeFile(sandbox, production + '\n(deny network*)(allow network-outbound (remote ip "localhost:' + address.port + '"))', { mode: 0o600 })
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.stubEnv('RERUN_DATA_DIR', data)
        vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', binary)
        vi.stubEnv('RERUN_DESKTOP_CLAUDE_SANDBOX', sandbox)
        clearCachedEnvForTests()
        runtime = desktopClaudeRuntime('mac-claude', 'synthetic-loopback-only', {
            ...CLAUDE_HARNESS_ENV, ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + address.port,
            ANTHROPIC_API_KEY: 'synthetic-loopback-only',
        }, true)
        const processSettings = runtime.settings
        const allowed = stopDuringChild ? [] : [bridge]
        const rerun = createCustomMcpServer({ name: 'rerun', tools: {
            memory_search: { description: 'Read fixture', inputSchema: z.object({}), handler: async () => { admittedCalls++; return { content: [{ type: 'text', text: 'ok' }] } } },
            fixture_ungranted: { description: 'Outside fixture grants', inputSchema: z.object({}), handler: async () => { ungrantedCalls++; return { content: [{ type: 'text', text: 'ungranted' }] } } },
        } })
        const provider = createClaudeCode({ defaultSettings: {
            ...processSettings, ...desktopClaudeSubagents(allowed, controller.signal, {}),
            systemPrompt: 'Fixture parent', mcpServers: { rerun },
            spawnClaudeCodeProcess: options => {
                const process = processSettings.spawnClaudeCodeProcess(options)
                workerPid = process.pid
                return process
            },
        } })
        try {
            const result = streamText({
                model: provider('claude-sonnet-4-5'), prompt: 'Delegate the fixture.', abortSignal: controller.signal, maxRetries: 0,
                onChunk: ({ chunk }) => { chunks.push(chunk) },
            })
            await result.consumeStream({ onError: error => { if (!controller.signal.aborted) throw error } })
            if (!controller.signal.aborted) {
                messages = (await result.response).messages
                finalText = await result.text
            }
        } catch (err) {
            if (!stopDuringChild || !controller.signal.aborted || childTurns !== 1) throw err
        }
    } finally {
        clearTimeout(deadline)
        controller.abort()
        try { await runtime?.close() }
        finally {
            server.closeAllConnections()
            await new Promise<void>(done => server.close(() => done()))
            vi.unstubAllEnvs()
            clearCachedEnvForTests()
            try {
                if (runtime) expect(await readdir(join(data, 'claude'))).toEqual([])
                if (workerPid) expect(() => process.kill(-workerPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
            } finally { await rm(data, { recursive: true, force: true }) }
        }
    }
    return { parentTurns, childTurns, advertised, chunks, messages, finalText, admittedCalls, ungrantedCalls, parentGotResult, sawRefusal, workerPid }
}

describe.skipIf(process.platform !== 'darwin')('bundled Claude native subagents with a loopback model', () => {
    it('runs the real foreground Agent, refuses an ungranted bridge and publishes only the parent step and answer', async () => {
        const result = await runFixture(false)
        expect(result).toMatchObject({ parentTurns: 2, childTurns: 3, admittedCalls: 1, ungrantedCalls: 0, parentGotResult: true, sawRefusal: true })
        expect(result.advertised).toEqual([[bridge], [bridge], [bridge]])
        const childCall = { toolName: 'native_subagent', toolCallId: 'parent-helper', providerExecuted: true }
        expect(result.chunks).toContainEqual(expect.objectContaining({ ...childCall, type: 'tool-call', input: { name: 'Claude helper 1' } }))
        expect(result.chunks).toContainEqual(expect.objectContaining({ ...childCall, type: 'tool-result', output: { status: 'completed' } }))
        expect(JSON.stringify(result.messages)).toContain('Claude helper 1')
        expect(JSON.stringify(result.messages)).toContain('completed')
        expect(result.finalText).toBe('Parent complete')
        for (const privateValue of [HELPER_PRIVATE, 'child-ungranted', 'child-granted', 'Read the fixture.', 'control_request', 'hook_callback']) {
            expect(JSON.stringify([result.chunks, result.messages, result.finalText])).not.toContain(privateValue)
        }
    }, 35_000)

    it('drains the confined process group when Stop interrupts an active child with no granted tools', async () => {
        const result = await runFixture(true)
        expect(result).toMatchObject({ childTurns: 1, parentTurns: 1, advertised: [[]], admittedCalls: 0, ungrantedCalls: 0 })
        expect(result.workerPid).toBeGreaterThan(0)
    }, 35_000)
})
