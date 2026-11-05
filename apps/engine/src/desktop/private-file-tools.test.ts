import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ToolSet } from 'ai'
import type { RunContext } from '../runtime/context.js'
const state = vi.hoisted(() => ({enabled: true, granted: true, filesystem: true, hub: 'http://127.0.0.1:3123', release: vi.fn()}))
vi.mock('../config/env.js', () => ({env: () => ({RERUN_HUB_BASE_URL: state.hub, RERUN_API_KEY: 'engine-only'})}))
vi.mock('../agents/loader.js', () => ({readAgentConfig: async () => ({enabled: state.enabled, tools: {filesystem: state.filesystem, desktopToolGrants: {privateFileWrite: state.granted}}})}))
vi.mock('./agent-lifecycle.js', () => ({beginDesktopAgentWork: () => state.release}))
import { desktopPrivateFileTools } from './private-file-tools.js'

const ctx = (abortSignal = new AbortController().signal) => ({agent: {id: 'engine-owner', config: {enabled: true,
    tools: {filesystem: true, desktopToolGrants: {privateFileWrite: state.granted}}}}, sessionId: 'session', runId: 'run', abortSignal} as unknown as RunContext)
const input = {path: 'docs/note.md', oldString: 'old', newString: 'new'}
const execute = (tools: ToolSet, toolCallId = 'call') => (tools.fs_edit as unknown as {
    execute: (args: unknown, options: {toolCallId: string; messages: unknown[]}) => Promise<unknown>
}).execute(input, {toolCallId, messages: []})
const saved = {status: 'saved', path: input.path, message: 'Edited docs/note.md (1 replacement)'}
beforeEach(() => {state.enabled = true; state.granted = true; state.filesystem = true; state.hub = 'http://127.0.0.1:3123'; state.release.mockClear()})
afterEach(() => {vi.unstubAllGlobals()})

test('uses the trusted run identity, fixed authenticated loopback route and exact invocation ID', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(saved))
    vi.stubGlobal('fetch', fetcher)
    expect(JSON.parse(String(await execute(desktopPrivateFileTools(ctx()))))).toEqual(saved)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, request] = fetcher.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3123/api/desktop/engine/private-file-tools')
    expect(request).toMatchObject({method: 'POST', redirect: 'error', credentials: 'omit', headers: {Authorization: 'Bearer engine-only'}})
    expect(JSON.parse(String(request.body))).toEqual({engineAgentId: 'engine-owner', sessionId: 'session', runId: 'run', toolCallId: 'call', tool: 'fs_edit', arguments: input})
    expect(state.release).toHaveBeenCalledTimes(1)
})

test.each(['grant', 'filesystem', 'enabled'] as const)('fresh %s revocation prevents a previously built tool from reaching the bridge', async kind => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const tools = desktopPrivateFileTools(ctx())
    if (kind === 'grant') state.granted = false
    else state[kind] = false
    await expect(execute(tools)).rejects.toThrow('turned off')
    expect(fetcher).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledTimes(1)
})

test('the private write grant starts off and cannot be widened by ordinary file-read access', () => {
    state.granted = false
    expect(desktopPrivateFileTools(ctx())).toEqual({})
})

test.each(['https://example.com', 'http://127.0.0.1:3123/other', 'http://user:secret@127.0.0.1:3123'])('refuses untrusted callback configuration %s', async hub => {
    state.hub = hub
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(execute(desktopPrivateFileTools(ctx()))).rejects.toThrow('unavailable')
    expect(fetcher).not.toHaveBeenCalled()
})

test.each(['unknown', 'refused'])('an %s receipt is not returned to the model as a saved edit', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({...saved, status, message: 'Inspect Files before retrying.'})))
    await expect(execute(desktopPrivateFileTools(ctx()))).rejects.toThrow('Inspect Files')
})

test.each(['fetch', 'reader'] as const)('Stop settles a non-cooperating %s and releases admission', async mode => {
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    const cancel = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => {
        if (mode === 'fetch') {entered(); return new Promise<Response>(() => {})}
        return {ok: true, body: {getReader: () => ({read: () => {entered(); return new Promise(() => {})}, cancel})}} as unknown as Response
    }))
    const pending = execute(desktopPrivateFileTools(ctx(controller.signal)))
    const refused = expect(pending).rejects.toThrow()
    await started
    controller.abort()
    await refused
    expect(state.release).toHaveBeenCalledTimes(1)
    if (mode === 'reader') expect(cancel).toHaveBeenCalled()
})

test('revocation while awaiting the acknowledgement suppresses its successful model result', async () => {
    let finish!: (response: Response) => void, entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    vi.stubGlobal('fetch', vi.fn(() => {entered(); return new Promise<Response>(resolve => {finish = resolve})}))
    const pending = execute(desktopPrivateFileTools(ctx())), denied = expect(pending).rejects.toThrow('turned off')
    await started
    state.filesystem = false
    finish(Response.json(saved))
    await denied
})
