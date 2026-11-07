import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webFetchRunGeneration } from '../../../../../engine/src/desktop/web-fetch-continuation/continuation'
import { handleDesktopBrowserExports } from './binding'

const mocks = vi.hoisted(() => ({
    readRuntime: vi.fn(),
    openDatabase: vi.fn(),
    ensureSchema: vi.fn(),
    createService: vi.fn(),
    publish: vi.fn(),
}))

vi.mock('../runtime', () => ({ readDesktopRuntime: mocks.readRuntime }))
vi.mock('../database', () => ({ openDesktopDatabase: mocks.openDatabase }))
vi.mock('./schema', () => ({ ensureDesktopBrowserExportsSchema: mocks.ensureSchema }))
vi.mock('./service', () => ({ createDesktopBrowserExports: mocks.createService }))

const runtime = {
    dataRoot: '/fixture/browser-export',
    launchNonce: 'fixture-launch',
    app: { origin: 'http://127.0.0.1:41000', sessionToken: 'browser-session' },
    engine: { apiKey: 'fixture-engine-key' },
}
const runId = '17d9ec6c-d414-4867-824b-52d3d6956910'
const call = {
    engineAgentId: 'reader',
    sessionId: 'session',
    runId,
    toolCallId: 'tool-call',
    target: { engineAgentId: 'reader', launchNonce: runtime.launchNonce, sessionGeneration: webFetchRunGeneration(runId) },
    url: 'https://example.com/',
}
const browserCall = { ...call, target: { ...call.target, sessionGeneration: 'b'.repeat(32) }, navigation: { url: call.url } }
const artifact = (kind: 'served-html' | 'rendered-html' | 'page-metadata' | 'screenshot', path: string) => ({
    kind, path, mediaType: kind === 'screenshot' ? 'image/png' : 'text/plain',
    bytes: Buffer.from('fixture data').toString('base64'),
    sha256: 'a'.repeat(64),
})
const served = artifact('served-html', '.rerun/pages/example.served.html.txt')
const rendered = artifact('rendered-html', '.rerun/pages/example.browser.html.txt')
const metadata = artifact('page-metadata', '.rerun/pages/example.meta.txt')
const screenshot = artifact('screenshot', 'screenshot.png')
const publish = (operation: 'publish-web-fetch' | 'publish', source: typeof call, artifacts: ReturnType<typeof artifact>[]) =>
    handleDesktopBrowserExports(new Request(`${runtime.app.origin}/api/desktop/engine/browser-exports`, {
        method: 'POST',
        headers: { host: new URL(runtime.app.origin).host, authorization: `Bearer ${runtime.engine.apiKey}` },
        body: JSON.stringify({ operation, launchNonce: runtime.launchNonce, call: source, artifacts }),
    }))

beforeEach(() => {
    vi.resetAllMocks()
    mocks.readRuntime.mockResolvedValue(runtime)
    mocks.openDatabase.mockResolvedValue({})
    mocks.createService.mockReturnValue({ publish: mocks.publish })
    mocks.publish.mockResolvedValue({ status: 'saved', files: [] })
})
afterEach(() => { Reflect.deleteProperty(globalThis, Symbol.for('rerun.desktop.browser-export-publishers.v1')) })

describe('desktop browser export publication boundary', () => {
    it('routes served and rendered publication through their respective authorities', async () => {
        expect((await publish('publish-web-fetch', call, [served, metadata])).status).toBe(200)
        expect((await publish('publish', browserCall, [rendered, metadata])).status).toBe(200)
        expect(mocks.createService.mock.calls.map(([, , options]) => options)).toEqual([{ webFetch: true }, { webFetch: false }])
        expect(mocks.publish.mock.calls.map(([input]) => input.artifacts.map((item: { kind: string }) => item.kind))).toEqual([
            ['served-html', 'page-metadata'], ['rendered-html', 'page-metadata'],
        ])
    })

    it('rejects cross-operation artifacts, navigation and a mismatched run generation before publication', async () => {
        for (const response of [
            await publish('publish-web-fetch', call, [rendered, metadata]),
            await publish('publish-web-fetch', call, [served, metadata, screenshot]),
            await publish('publish-web-fetch', call, [served]),
            await publish('publish-web-fetch', { ...browserCall, target: call.target }, [served, metadata]),
            await publish('publish-web-fetch', { ...call, target: browserCall.target }, [served, metadata]),
            await publish('publish', browserCall, [served, metadata]),
        ]) expect(response.status).toBe(400)
        expect(mocks.publish).not.toHaveBeenCalled()
    })
})
