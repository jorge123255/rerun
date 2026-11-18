import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { HookInput, Options, SpawnedProcess } from 'ai-sdk-provider-claude-code'
import { describe, expect, it } from 'vitest'
import { desktopClaudeChildDisplay, desktopClaudeSubagents } from './subagents.js'

const bridge = 'mcp__rerun__memory_search'
const server = { name: 'rerun', source: 'sdk' }
const spawnInput = { prompt: 'A synthetic task', description: 'Synthetic test' }
const base = { session_id: 'session', cwd: '/fixture', transcript_path: '/fixture/transcript' }
const bridgeTools = [bridge, 'mcp__rerun__delegate_tasks', 'mcp__rerun__call_agent']

function fixture() {
    const parent = new AbortController()
    const settings = desktopClaudeSubagents(bridgeTools, parent.signal, {})
    const hook = async (input: HookInput) => {
        const matcher = settings.hooks[input.hook_event_name as 'PreToolUse']
        const result = await matcher[0]!.hooks[0]!(input, undefined, { signal: parent.signal })
        return 'hookSpecificOutput' in result ? result.hookSpecificOutput : undefined
    }
    const before = (name: string, tool: Record<string, unknown>, id = 'call-id', child?: string, source?: typeof server) =>
        hook({ ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_input: tool, tool_use_id: id, agent_id: child, mcp_server: source })
    return { parent, settings, before, hook }
}

describe('desktop Claude native helpers', () => {
    it('pins foreground helpers to the parent model and its bridge, denying other kinds, remote, background, and nested dispatch', async () => {
        const { settings, before } = fixture()
        expect(settings.tools).toEqual(['Agent'])
        expect(settings.agents['rerun-helper']).toMatchObject({ tools: [bridge], permissionMode: 'dontAsk', model: 'inherit', background: false })
        expect(settings.hooks.PreToolUse[0]!.onFailure).toBe('block')
        for (const input of [{ isolation: 'remote' }, { run_in_background: true }, { subagent_type: 'Explore' }, { resume: 'old' }, { model: 'opus' }, { mode: 'bypassPermissions' }]) {
            expect(await before('Agent', { ...spawnInput, ...input })).toMatchObject({ permissionDecision: 'deny' })
        }
        expect(await before('Agent', spawnInput, 'first')).toMatchObject({ permissionDecision: 'allow', updatedInput: { ...spawnInput, subagent_type: 'rerun-helper', run_in_background: false } })
        expect(await before('Agent', spawnInput, 'nested', 'child')).toMatchObject({ permissionDecision: 'deny' })
        for (const name of ['Bash', 'Read', 'WebFetch', 'mcp__rerun__delegate_tasks', 'mcp__rerun__call_agent', 'mcp__rerun__unknown']) {
            expect(await before(name, {}, 'request', 'child', server)).toMatchObject({ permissionDecision: 'deny' })
        }
        expect(await before(bridge, {}, 'read', 'child', { ...server, source: 'project' })).toMatchObject({ permissionDecision: 'deny' })
        expect(await before(bridge, {}, 'read', 'child')).toMatchObject({ permissionDecision: 'deny' })
        expect(await before(bridge, {}, 'read', 'child', server)).toMatchObject({ permissionDecision: 'allow' })
    })

    it('bounds parallel work, releases slots on success and failure, and rejects activity after parent Stop', async () => {
        const { before, hook, parent } = fixture()
        const calls = await Promise.all(['one', 'two', 'three', 'four'].map(id => before('Agent', spawnInput, id)))
        expect(calls.map(call => call?.permissionDecision)).toEqual(['allow', 'allow', 'allow', 'deny'])
        expect(await before('Agent', spawnInput, 'one')).toMatchObject({ permissionDecision: 'deny' })
        await hook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: spawnInput, tool_use_id: 'one', tool_response: {} })
        expect(await before('Agent', spawnInput, 'five')).toMatchObject({ permissionDecision: 'allow' })
        await hook({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_input: spawnInput, tool_use_id: 'two', error: 'fixture' })
        expect(await before('Agent', spawnInput, 'six')).toMatchObject({ permissionDecision: 'allow' })
        parent.abort()
        expect(await before(bridge, {}, 'read', 'child', server)).toMatchObject({ permissionDecision: 'deny' })
        expect(await before('Agent', spawnInput, 'seven')).toMatchObject({ permissionDecision: 'deny' })
    })

    it('keeps child streams and transcripts private while preserving permission RPC and the parent reply', () => {
        let next = 0
        const project = desktopClaudeChildDisplay(() => ++next)
        const display = (message: unknown) => project(JSON.stringify(message))
        for (const type of ['tool_use_summary', 'tool_progress']) expect(display({ type, summary: 'PRIVATE' })).toBe('')
        expect(display({ type: 'system', subtype: 'task_notification', summary: 'PRIVATE' })).toBe('')
        const child = { parent_tool_use_id: 'agent-call' }
        for (const type of ['assistant', 'stream_event', 'user']) expect(display({ type, ...child, message: 'PRIVATE' })).toBe('')
        expect(display({ type: 'control_request', ...child, request: { subtype: 'hook_callback' } })).toContain('hook_callback')
        for (const event of [{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'Agent' } }, { type: 'content_block_delta', index: 2, delta: { partial_json: 'PRIVATE' } }, { type: 'content_block_stop', index: 2 }]) expect(display({ type: 'stream_event', event })).toBe('')
        const call = display({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent-call', input: { prompt: 'PRIVATE' } }] } })
        expect(JSON.parse(call).message.content).toEqual([{ type: 'tool_use', name: 'native_subagent', id: 'agent-call', input: { name: 'Claude helper 1' } }])
        expect(display({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'second', input: { prompt: 'PRIVATE' } }] } })).toContain('Claude helper 2')
        const result = display({ type: 'user', tool_use_result: 'PRIVATE', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'PRIVATE', is_error: true }] } })
        expect(result).not.toContain('PRIVATE')
        expect(JSON.parse(JSON.parse(result).message.content[0].content)).toEqual({ status: 'failed' })
        expect(display({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Parent conclusion' }] } })).toContain('Parent conclusion')
    })
})

// Use the SDK instance the pinned provider actually loads. This fixture replaces
// only the CLI's pipes. No executable, host profile, network, or account is used.
it('delivers a child hook and child permission request through the pinned Claude SDK transport', async () => {
    const require = createRequire(import.meta.url)
    const sdk = await import(pathToFileURL(createRequire(require.resolve('ai-sdk-provider-claude-code')).resolve('@anthropic-ai/claude-agent-sdk')).href)
    const { settings } = fixture()
    const cli = Object.assign(new EventEmitter(), { killed: false, exitCode: null as number | null, stdin: new PassThrough(), stdout: new PassThrough(), kill() { return true } })
    const decisions: Record<string, unknown> = {}
    let callback: string
    const send = (data: object) => cli.stdout.write(JSON.stringify(data) + '\n')
    const request = (id: string, content: object) => send({ type: 'control_request', request_id: id, request: content })
    const tool = { tool_name: 'Bash', input: { command: 'blocked' }, tool_use_id: 'child-tool', agent_id: 'child' }
    cli.stdin.setEncoding('utf8').on('data', (chunk: string) => {
        for (const line of chunk.trim().split('\n')) {
            const msg = JSON.parse(line)
            if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
                callback = msg.request.hooks.PreToolUse[0].hookCallbackIds[0]
                send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { hooks_applied: true, hook_on_failure_supported: true } } })
            } else if (msg.type === 'user') {
                request('wire-hook', { subtype: 'hook_callback', callback_id: callback, tool_use_id: 'child-tool', input: { ...base, hook_event_name: 'PreToolUse', tool_input: tool.input, ...tool } })
                request('wire-permission', { subtype: 'can_use_tool', ...tool })
            } else if (msg.type === 'control_response') {
                decisions[msg.response.request_id] = msg.response.response
                if (Object.keys(decisions).length === 2) {
                    send({ type: 'result', subtype: 'success', is_error: false, result: 'fixture complete', duration_ms: 1, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], session_id: base.session_id, uuid: 'fixture' })
                    cli.stdout.end()
                    setImmediate(() => { cli.exitCode = 0; cli.emit('exit', 0, null) })
                }
            }
        }
    })
    const options: Options = { ...settings, persistSession: false, settingSources: [], permissionMode: 'dontAsk', pathToClaudeCodeExecutable: '/fixture/claude', spawnClaudeCodeProcess: () => cli as SpawnedProcess }
    const query = sdk.query({ prompt: (async function* () { yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'fixture' } } })(), options })
    try { for await (const _ of query) { /* drain until the fake CLI exits */ } } finally { query.close() }
    expect(decisions).toMatchObject({ 'wire-hook': { hookSpecificOutput: { permissionDecision: 'deny' } }, 'wire-permission': { behavior: 'deny' } })
})
