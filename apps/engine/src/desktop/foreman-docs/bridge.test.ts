import { expect, it, vi } from 'vitest'
import { RERUN_PUBLIC_DOCS_CORPUS } from '@rerun/contracts'
import { createDesktopForemanDocsBridge } from './bridge.js'

const runtime = { launchNonce: '123e4567-e89b-42d3-a456-426614174000', app: { origin: 'http://127.0.0.1:3050' }, engine: { apiKey: 'a'.repeat(64) } }
const binding = { workspaceId: '1', chatId: 'fmc_chat-0001', runId: 'run-1', model: { connectionId: 'conn-1', model: 'model-a' } }
const result = { status: 'unavailable', documentation: RERUN_PUBLIC_DOCS_CORPUS.documentation, passages: [], source: null, note: 'Unavailable.' }

it('calls only the authenticated loopback documentation adapter with the exact request', async () => {
    const network = vi.fn(async () => Response.json(result))
    const bridge = createDesktopForemanDocsBridge(runtime, network)
    expect(await bridge.search({ binding, toolCallId: 'call-1', query: 'billing', corpus: RERUN_PUBLIC_DOCS_CORPUS }, new AbortController().signal)).toEqual(result)
    const [url, init] = network.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3050/api/desktop/internal/foreman-docs')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ action: 'search_docs', launchNonce: runtime.launchNonce, binding, toolCallId: 'call-1', query: 'billing' })
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${runtime.engine.apiKey}`)
})

it('refuses a non-loopback or credentialed callback authority', () => {
    expect(() => createDesktopForemanDocsBridge({ ...runtime, app: { origin: 'https://docs.rerun.build' } })).toThrow()
    expect(() => createDesktopForemanDocsBridge({ ...runtime, app: { origin: 'http://127.0.0.1:3050/path' } })).toThrow()
})
