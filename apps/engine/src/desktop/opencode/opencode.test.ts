import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_OPENCODE_SNAPSHOT, desktopOpencodeEnableProblem, desktopOpencodeKeyProblem, desktopOpencodeModelRows, desktopOpencodeVisionModel, desktopOpencodeWindows, parseDesktopOpencodeCatalog } from '@rerun/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopOpencodeCatalogView, desktopOpencodeDispatchModel, refreshDesktopOpencodeCatalog, refreshStaleDesktopOpencodeCatalog, resetDesktopOpencodeCatalogForTests } from './catalog.js'
import { executeDesktopOpencode } from './execute.js'
import { refreshDesktopOpencodeLimits, refreshStaleDesktopOpencodeLimits, resetDesktopOpencodeLimitsForTests } from './limits.js'
import { DesktopOpencodeModelError, desktopOpencodeLanguageModel } from './model.js'
import { desktopOpencodeCacheWrite, desktopOpencodeHttpRequest, parseDesktopOpencodeSse } from './wire.js'

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', name), 'utf8')
const captured = JSON.parse(fixture('captured-catalog.json')) as unknown
const limitsBody = JSON.parse(fixture('limits.json')) as unknown
const consoleCatalog = { data: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', type: 'chat', modalities: { input: ['text', 'image'] }, capabilities: { tools: { supported: true }, reasoning: { supported: true } }, limit: { context: 1000000, input: 1000000, output: 128000 }, cost: { text: { input: { price: 0.1, cache: { read: 0.01 } }, output: { price: 0.5 } } }, api: { messages: { base_url: 'https://opencode.ai/inference/anthropic/v1' } } }] }
const goOnly = { data: [captured && (captured as { data: unknown[] }).data[0]] }

function catalogs(go: unknown, consoleBody: unknown, fail = false): typeof fetch {
    return async url => {
        if (fail) return new Response('down', { status: 503 })
        const href = String(url)
        if (href.includes('/go/v1/models')) return Response.json(go)
        if (href.endsWith('/v1/models')) return Response.json(consoleBody)
        return new Response('unexpected', { status: 500 })
    }
}

const dispatch = { workspaceId: 1, connectionId: 'oc', connectionRevision: 'rev-1', consoleEnabled: false, modelId: 'go/deepseek-v4-pro', purpose: 'chat' as const, runId: 'run-1', requestId: 'req-1', sessionId: 'session-1', stream: true }

describe('desktop OpenCode contract', () => {
    it('parses a captured catalog and skips free, non-chat, and off-origin rows', () => {
        const models = parseDesktopOpencodeCatalog(captured, 'go')
        expect(models.map(model => model.id)).toEqual(['go/deepseek-v4-pro'])
        expect(models[0]?.wire).toBe('chat')
        expect(models[0]?.images).toBe(false)
        expect(DESKTOP_OPENCODE_SNAPSHOT).toHaveLength(96)
        expect(DESKTOP_OPENCODE_SNAPSHOT.some(model => model.id === 'go/deepseek-v4-pro')).toBe(true)
        expect(DESKTOP_OPENCODE_SNAPSHOT.some(model => model.id === 'console/claude-haiku-5-5')).toBe(true)
    })

    it('rejects ChatGPT, Anthropic, OpenAI, and OpenRouter credentials', () => {
        expect(desktopOpencodeKeyProblem('')).toMatch(/oc_sk_/)
        expect(desktopOpencodeKeyProblem('eyJchatgpt')).toMatch(/ChatGPT/)
        expect(desktopOpencodeKeyProblem('sk-ant-api')).toMatch(/Anthropic/)
        expect(desktopOpencodeKeyProblem('sk-or-v1-secret')).toMatch(/OpenRouter/)
        expect(desktopOpencodeKeyProblem('sk-openai')).toMatch(/OpenAI/)
        expect(desktopOpencodeKeyProblem('oc_sk_test')).toBeNull()
    })

    it('projects Go windows, including a spent non-ok status, and ignores a garbage body', () => {
        const windows = desktopOpencodeWindows(limitsBody)
        expect(windows.map(window => window.kind)).toEqual(['session', 'weekly', 'monthly'])
        expect(windows[0]).toMatchObject({ usedPercent: 100, label: null })
        expect(desktopOpencodeWindows({ nope: true })).toEqual([])
    })

    it('keeps Console locked until it is switched on and keeps the default in the enabled set', () => {
        const known = DESKTOP_OPENCODE_SNAPSHOT.map(model => model.id)
        expect(desktopOpencodeEnableProblem({ enabledModelIds: ['console/claude-haiku-5-5'], defaultModelId: 'console/claude-haiku-5-5', consoleEnabled: false, knownIds: known })).toMatch(/Console/)
        expect(desktopOpencodeEnableProblem({ enabledModelIds: ['go/glm-5.2'], defaultModelId: 'go/deepseek-v4-pro', consoleEnabled: false, knownIds: known })).toMatch(/default/)
        expect(desktopOpencodeEnableProblem({ enabledModelIds: ['go/deepseek-v4-pro'], defaultModelId: 'go/deepseek-v4-pro', consoleEnabled: false, knownIds: known })).toBeNull()
        const rows = desktopOpencodeModelRows({ models: DESKTOP_OPENCODE_SNAPSHOT, source: 'snapshot', enabledModelIds: ['go/deepseek-v4-pro'], consoleEnabled: false })
        expect(rows.find(row => row.id === 'console/claude-haiku-5-5')).toMatchObject({ locked: true, lockReason: 'Off until you switch Console on.' })
        expect(rows.findIndex(row => row.plan === 'console')).toBeGreaterThan(rows.findIndex(row => row.plan === 'go'))
    })

    it('picks the cheapest seeing Go model and never a Console model', () => {
        const enabled = DESKTOP_OPENCODE_SNAPSHOT.filter(model => model.id === 'go/deepseek-v4-pro' || model.id === 'go/gpt-6-luna' || model.id === 'console/claude-haiku-5-5')
        expect(desktopOpencodeVisionModel(enabled)).toBe('go/gpt-6-luna')
        expect(desktopOpencodeVisionModel(enabled.filter(model => !model.images))).toBeNull()
    })
})

describe('desktop OpenCode wires', () => {
    const go = DESKTOP_OPENCODE_SNAPSHOT.find(model => model.id === 'go/deepseek-v4-pro')!
    const messages = DESKTOP_OPENCODE_SNAPSHOT.find(model => model.id === 'console/claude-haiku-5-5')!
    const responses = DESKTOP_OPENCODE_SNAPSHOT.find(model => model.id === 'go/gpt-6-luna')!
    const google = DESKTOP_OPENCODE_SNAPSHOT.find(model => model.id === 'go/gemini-4-argon')!

    it('builds the four original requests with the upstream id only', () => {
        const chat = desktopOpencodeHttpRequest(go, 'oc_sk_test', 'session-1', true)
        expect(chat.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
        expect(chat.headers.authorization).toBe('Bearer oc_sk_test')
        expect(chat.headers['x-opencode-session']).toBe('session-1')
        expect(chat.body).toMatchObject({ model: 'deepseek-v4-pro', stream: true })
        expect(chat.body).not.toHaveProperty('reasoning')
        const haiku = desktopOpencodeHttpRequest(messages, 'oc_sk_test', 'session-1', true)
        expect(haiku.url).toBe('https://opencode.ai/inference/anthropic/v1/messages')
        expect(haiku.headers['x-api-key']).toBe('oc_sk_test')
        expect(haiku.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 32000 })
        const luna = desktopOpencodeHttpRequest(responses, 'oc_sk_test', 'session-1', true)
        expect(luna.url).toBe('https://opencode.ai/inference/go/openai/v1/responses')
        expect(luna.body).toMatchObject({ model: 'gpt-6-luna', store: false })
        const argon = desktopOpencodeHttpRequest(google, 'oc_sk_test', 'session-1', true)
        expect(argon.url).toBe('https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse')
        expect(argon.headers['x-goog-api-key']).toBe('oc_sk_test')
        expect(desktopOpencodeHttpRequest(google, 'oc_sk_test', 'session-1', false).url).toContain(':generateContent')
    })

    it('normalizes the four captured streams', () => {
        const chat = parseDesktopOpencodeSse(go, fixture('chat-go.sse'))
        expect(chat).toMatchObject({ text: 'Let me check.', terminal: 'completed', toolNames: ['lookup'] })
        expect(chat.reasoning).toContain('lookup')
        expect(chat.usage && desktopOpencodeCacheWrite(chat.usage)).toBe(0)
        const haiku = parseDesktopOpencodeSse(messages, fixture('messages-console.sse'))
        expect(haiku).toMatchObject({ text: 'Hello from Haiku.', terminal: 'completed' })
        expect(haiku.reasoning).toBe('A short answer will do.')
        expect(haiku.usage && desktopOpencodeCacheWrite(haiku.usage)).toBe(2560)
        expect(parseDesktopOpencodeSse(responses, fixture('responses-go.sse')).text).toBe('Hello from Luna.')
        expect(parseDesktopOpencodeSse(google, fixture('google-go.sse')).text).toBe('Hello from Argon.')
        expect(parseDesktopOpencodeSse(go, 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n').terminal).toBe('unknown')
    })
})

describe('desktop OpenCode catalog, limits, and dispatch', () => {
    beforeEach(() => {
        resetDesktopOpencodeCatalogForTests()
        resetDesktopOpencodeLimitsForTests()
    })

    it('keeps the snapshot and the selected model when refresh fails, and does not call it live', async () => {
        const refresh = await refreshDesktopOpencodeCatalog({ workspaceId: 1, requestId: 'cat-1', selectedModelId: 'go/deepseek-v4-pro', fetch: catalogs(captured, consoleCatalog, true), now: 1_000 })
        expect(refresh).toMatchObject({ source: 'snapshot', fresh: false, selectedPreserved: true, capturedAt: null, retiredModelIds: [] })
        expect(refresh.unavailableReason).toMatch(/did not answer/)
        expect(refreshStaleDesktopOpencodeCatalog({ workspaceId: 1, requestId: 'cat-2', selectedModelId: 'go/deepseek-v4-pro', fetch: catalogs(captured, consoleCatalog), now: 1_000 + 60_000 })).toBeNull()
        expect(desktopOpencodeCatalogView({ workspaceId: 1, requestId: 'read', selectedModelId: 'go/deepseek-v4-pro' }).fresh).toBe(false)
    })

    it('retires a model only from a live reading and does not publish that reading to another workspace', async () => {
        const live = await refreshDesktopOpencodeCatalog({ workspaceId: 2, requestId: 'cat-live', selectedModelId: 'go/deepseek-v4-pro', enabledModelIds: ['go/deepseek-v4-pro'], fetch: catalogs(goOnly, consoleCatalog), now: 5_000 })
        expect(live.fresh).toBe(true)
        expect(live.retiredModelIds).toEqual([])
        const retired = await refreshDesktopOpencodeCatalog({ workspaceId: 2, requestId: 'cat-retired', selectedModelId: 'go/deepseek-v4-pro', enabledModelIds: ['go/deepseek-v4-pro'], fetch: catalogs({ data: [{ ...(goOnly.data[0] as object), id: 'glm-5.2', name: 'GLM-5.2' }] }, consoleCatalog), now: 6_000 })
        expect(retired.fresh).toBe(true)
        expect(retired.retiredModelIds).toContain('go/deepseek-v4-pro')
        expect(retired.selectedPreserved).toBe(true)
        expect(desktopOpencodeDispatchModel(2, 'go/deepseek-v4-pro').kind).toBe('retired')
        expect(desktopOpencodeDispatchModel(1, 'go/deepseek-v4-pro').kind).toBe('model')
    })

    it('reads usage windows without refusing the key when the usage call fails', async () => {
        const calls: string[] = []
        const windows = await refreshDesktopOpencodeLimits({ workspaceId: 1, connectionId: 'oc', apiKey: 'oc_sk_test', now: 10, fetch: async url => { calls.push(String(url)); return Response.json(limitsBody) } })
        expect(calls).toEqual(['https://opencode.ai/zen/go/v1/usage'])
        expect(windows?.[0]?.usedPercent).toBe(100)
        expect(await refreshDesktopOpencodeLimits({ workspaceId: 1, connectionId: 'other', apiKey: 'oc_sk_test', fetch: async () => new Response('no', { status: 401 }) })).toBeNull()
        expect(refreshStaleDesktopOpencodeLimits({ workspaceId: 1, connectionId: 'oc', apiKey: 'oc_sk_test', now: 11, fetch: async () => { throw new Error('should not run') } })).toBeNull()
        expect(await refreshDesktopOpencodeLimits({ workspaceId: 1, connectionId: 'blank', apiKey: null, fetch: async () => { throw new Error('should not run') } })).toBeNull()
    })

    it('does not send when the key, Console switch, Stop, or a retired model blocks the call', async () => {
        const fetch = vi.fn<typeof fetch>()
        const stopped = new AbortController(); stopped.abort()
        expect(await executeDesktopOpencode({ dispatch, apiKey: 'oc_sk_test', fetch, signal: stopped.signal })).toMatchObject({ status: 'refused', code: 'cancelled', sent: false })
        expect(await executeDesktopOpencode({ dispatch, apiKey: 'eyJchatgpt', fetch })).toMatchObject({ code: 'credential', sent: false })
        expect(await executeDesktopOpencode({ dispatch: { ...dispatch, modelId: 'console/claude-haiku-5-5', consoleEnabled: false }, apiKey: 'oc_sk_test', fetch })).toMatchObject({ code: 'console', sent: false })
        await refreshDesktopOpencodeCatalog({ workspaceId: 1, requestId: 'retire', selectedModelId: 'go/deepseek-v4-pro', enabledModelIds: ['go/deepseek-v4-pro'], fetch: catalogs({ data: [{ ...(goOnly.data[0] as object), id: 'glm-5.2', name: 'GLM-5.2' }] }, consoleCatalog), now: 9 })
        expect(await executeDesktopOpencode({ dispatch, apiKey: 'oc_sk_test', fetch })).toMatchObject({ code: 'retired', sent: false })
        expect(fetch).not.toHaveBeenCalled()
    })

    it('sends one chat completion and keeps an unknown transport or a partial stream', async () => {
        const seen: { url: string; init: RequestInit }[] = []
        const ok = await executeDesktopOpencode({
            dispatch, apiKey: 'oc_sk_test', prompt: { messages: [{ role: 'user', content: 'hi' }] },
            fetch: async (url, init) => { seen.push({ url: String(url), init: init ?? {} }); return new Response(fixture('chat-go.sse'), { status: 200 }) },
        })
        expect(ok).toMatchObject({ status: 'saved', sent: true, billingSource: 'go', cost: 0, text: 'Let me check.' })
        expect(seen[0]?.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
        expect(seen[0]?.init.redirect).toBe('error')
        expect(JSON.parse(String(seen[0]?.init.body)).model).toBe('deepseek-v4-pro')
        const partial = await executeDesktopOpencode({ dispatch: { ...dispatch, requestId: 'partial' }, apiKey: 'oc_sk_test', fetch: async () => new Response('data: {"choices":[{"delta":{"content":"Hel"}}]}\n', { status: 200 }) })
        expect(partial).toMatchObject({ status: 'partial', sent: true, text: 'Hel' })
        const unknown = await executeDesktopOpencode({ dispatch: { ...dispatch, requestId: 'lost' }, apiKey: 'oc_sk_test', fetch: async () => { throw new TypeError('fetch failed') } })
        expect(unknown).toMatchObject({ status: 'unknown', code: 'transport', sent: true })
    })

    it('rewrites 401, 402, and a Go 429, and leaves a plain 429 unknown when usage does not answer', async () => {
        const refused = await executeDesktopOpencode({ dispatch, apiKey: 'oc_sk_test', fetch: async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 }) })
        expect(refused).toMatchObject({ status: 'refused', code: 'credential', sent: true })
        expect(refused.message).toMatch(/OpenCode key refused \(401\)/)
        const credits = await executeDesktopOpencode({ dispatch: { ...dispatch, requestId: 'credits' }, apiKey: 'oc_sk_test', fetch: async () => new Response(JSON.stringify({ error: { message: 'payment' } }), { status: 402 }) })
        expect(credits.message).toMatch(/OpenCode Console credits used up/)
        const limited = await executeDesktopOpencode({
            dispatch: { ...dispatch, requestId: 'limit' }, apiKey: 'oc_sk_test',
            fetch: async url => String(url).includes('/usage') ? Response.json(limitsBody) : new Response('slow', { status: 429 }),
        })
        expect(limited).toMatchObject({ code: 'limit', sent: true })
        expect(limited.message).toMatch(/OpenCode Go limit reached: 5-hour window/)
        const plain = await executeDesktopOpencode({ dispatch: { ...dispatch, requestId: 'plain', connectionId: 'plain' }, apiKey: 'oc_sk_test', fetch: async url => String(url).includes('/usage') ? new Response('no', { status: 500 }) : new Response('slow', { status: 429 }) })
        expect(plain).toMatchObject({ status: 'unknown', code: 'unavailable', sent: true })
    })

    it('builds an SDK model only for an explicit Go key and refuses Console by default', () => {
        expect(() => desktopOpencodeLanguageModel({ workspaceId: 1, connectionId: 'oc', apiKey: 'eyJchatgpt', modelId: 'go/deepseek-v4-pro' })).toThrow(DesktopOpencodeModelError)
        expect(() => desktopOpencodeLanguageModel({ workspaceId: 1, connectionId: 'oc', apiKey: 'oc_sk_test', modelId: 'console/claude-haiku-5-5' })).toThrow(/Console/)
        const built = desktopOpencodeLanguageModel({ workspaceId: 1, connectionId: 'oc', apiKey: 'oc_sk_test', modelId: 'go/deepseek-v4-pro', fetch: async () => { throw new Error('construction must not fetch') } })
        expect(built.entry.upstreamId).toBe('deepseek-v4-pro')
        expect(built.middleware.length).toBeGreaterThan(0)
    })
})
