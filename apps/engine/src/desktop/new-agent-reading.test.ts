import { Hono } from 'hono'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({selected: vi.fn(), connection: vi.fn(), usable: vi.fn(), generate: vi.fn(),
    openai: vi.fn(), anthropic: vi.fn(), google: vi.fn(), languageModel: vi.fn(), chat: vi.fn()}))
vi.mock('../connections/default.js', () => ({readBoxDefault: mocks.selected}))
vi.mock('../connections/registry.js', () => ({findConnection: mocks.connection}))
vi.mock('../agents/availability.js', () => ({isUsable: mocks.usable}))
vi.mock('ai', async original => ({...await original<typeof import('ai')>(), generateText: mocks.generate}))
vi.mock('@ai-sdk/openai', () => ({createOpenAI: mocks.openai}))
vi.mock('@ai-sdk/anthropic', () => ({createAnthropic: mocks.anthropic}))
vi.mock('@ai-sdk/google', () => ({createGoogleGenerativeAI: mocks.google}))
// Importing the ordinary registry would construct CLI providers and create a phantom agent.
vi.mock('../agents/providers.js', () => { throw new Error('The name reader must not import a CLI/agent provider.') })
import { desktopNewAgentReadingRoutes, DESKTOP_JOB_READER_INSTRUCTIONS } from './new-agent-reading.js'
import { HttpError } from '../lib/errors.js'

const description = 'Review support emails every weekday at nine'
const reading = '{"name":"Support Reviewer","apps":[],"schedule":null}'
const connection = (provider = 'openai', env: Record<string, string> = {OPENAI_API_KEY: 'selected-key'}) => ({
    id: 'selected-connection', config: {provider, models: ['selected-model'], extraModels: []}, env,
})
const request = (body: unknown = {text: description}, signal?: AbortSignal) => new Request('http://localhost/desktop/new-agent/read', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal,
})
const app = new Hono()
app.route('/desktop/new-agent', desktopNewAgentReadingRoutes)
app.onError((error, c) => error instanceof HttpError ? c.json({error: error.message}, error.status as 400) : c.json({error: 'internal'}, 500))
beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv('RERUN_DESKTOP_APP', '1')
    mocks.selected.mockResolvedValue({connectionId: 'selected-connection', model: 'selected-model'})
    mocks.connection.mockResolvedValue(connection()); mocks.usable.mockReturnValue(true)
    mocks.languageModel.mockReturnValue({id: 'selected-model'}); mocks.chat.mockReturnValue({id: 'selected-model'})
    for (const factory of [mocks.openai, mocks.anthropic, mocks.google]) factory.mockReturnValue({languageModel: mocks.languageModel, chat: mocks.chat})
    mocks.generate.mockResolvedValue({text: reading})
})
afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers()})

test('uses only the selected workspace connection with the original JSON prompt and no tools', async () => {
    expect(await (await app.fetch(request())).json()).toEqual({reply: reading})
    expect(mocks.connection).toHaveBeenCalledWith('selected-connection')
    expect(mocks.openai).toHaveBeenCalledWith(expect.objectContaining({apiKey: 'selected-key', baseURL: 'https://api.openai.com/v1'}))
    expect(mocks.languageModel).toHaveBeenCalledWith('selected-model')
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({prompt: description, system: DESKTOP_JOB_READER_INSTRUCTIONS,
        tools: {}, toolChoice: 'none', maxOutputTokens: 300, maxRetries: 0, temperature: 0, providerOptions: {openai: {store: false}}}))
    expect(DESKTOP_JOB_READER_INSTRUCTIONS).toContain('same language as the description')
    expect(DESKTOP_JOB_READER_INSTRUCTIONS).toContain('source is the exact substring')
})

test('does not borrow ambient keys even when a provider reports the connection usable', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-must-not-be-used')
    mocks.connection.mockResolvedValue(connection('openai', {}))
    expect(await (await app.fetch(request())).json()).toEqual({reply: ''})
    expect(mocks.openai).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
})

test.each(['codex', 'claude', 'rerun'])('fails closed for %s without launching a tool-capable runner or a fallback model', async provider => {
    mocks.connection.mockResolvedValue(connection(provider, {RERUN_CHATGPT_CONNECTED: '1', CLAUDE_CODE_OAUTH_TOKEN: 'subscription'}))
    expect(await (await app.fetch(request())).json()).toEqual({reply: ''})
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.openai).not.toHaveBeenCalled(); expect(mocks.anthropic).not.toHaveBeenCalled()
})

test.each(['missing-default', 'missing-connection', 'disconnected'] as const)('returns an empty reading for %s instead of selecting another account', async mode => {
    if (mode === 'missing-default') mocks.selected.mockResolvedValue(null)
    if (mode === 'missing-connection') mocks.connection.mockResolvedValue(null)
    if (mode === 'disconnected') mocks.usable.mockReturnValue(false)
    expect(await (await app.fetch(request())).json()).toEqual({reply: ''})
    expect(mocks.generate).not.toHaveBeenCalled()
})

test('does not accept a default or credential change that occurred while its reply was pending', async () => {
    let finish!: (value: {text: string}) => void, entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    mocks.generate.mockImplementation(() => {entered(); return new Promise(resolve => {finish = resolve})})
    const pending = app.fetch(request())
    await started
    mocks.connection.mockResolvedValue(connection('openai', {OPENAI_API_KEY: 'replacement-key'}))
    finish({text: reading})
    expect(await (await pending).json()).toEqual({reply: ''})
})

test.each(['model', 'default-read'] as const)('enforces the six-second total deadline even when %s ignores cancellation', async phase => {
    vi.useFakeTimers()
    let entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    const stalled = () => {entered(); return new Promise(() => {})}
    if (phase === 'model') mocks.generate.mockImplementation(stalled)
    else mocks.selected.mockImplementation(stalled)
    const pending = app.fetch(request())
    await started
    await vi.advanceTimersByTimeAsync(6001)
    expect(await (await pending).json()).toEqual({reply: ''})
    if (phase === 'model') expect(mocks.generate.mock.calls[0]![0].abortSignal.aborted).toBe(true)
})

test('closing the dialog cancels a pending model response without waiting for the deadline', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    mocks.generate.mockImplementation(() => {entered(); return new Promise(() => {})})
    const stop = new AbortController(), pending = app.fetch(request(undefined, stop.signal))
    await started; stop.abort()
    expect(await (await pending).json()).toEqual({reply: ''})
    expect(mocks.generate.mock.calls[0]![0].abortSignal.aborted).toBe(true)
})

test.each([{text: 'x'.repeat(2001)}, {text: description, connectionId: 'attacker'}, {text: 7}])('rejects malformed or oversized input before selecting credentials', async input => {
    expect((await app.fetch(request(input))).status).toBe(400)
    expect(mocks.selected).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
})

test('never returns provider errors or an oversized reply in the dialog', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('selected-key must not be disclosed'))
    expect(await (await app.fetch(request())).json()).toEqual({reply: ''})
    mocks.generate.mockResolvedValueOnce({text: 'x'.repeat(8001)})
    expect(await (await app.fetch(request())).json()).toEqual({reply: ''})
})

test('is desktop-only and skips descriptions too short for the original reader', async () => {
    expect(await (await app.fetch(request({text: 'hi'}))).json()).toEqual({reply: ''})
    expect(mocks.generate).not.toHaveBeenCalled()
    vi.stubEnv('RERUN_DESKTOP_APP', '0')
    expect((await app.fetch(request())).status).toBe(404)
})
