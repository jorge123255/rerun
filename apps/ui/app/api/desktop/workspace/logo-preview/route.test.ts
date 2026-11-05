import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LOGO_TOO_LARGE, NO_LOGO_FOUND } from '@/lib/desktop/workspace-logo-link'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { POST } from './route'

const mocks = vi.hoisted(() => ({ fetchWorkspaceLogo: vi.fn() }))
vi.mock('@/lib/desktop/server/workspace-logo-fetch', () => ({
    fetchWorkspaceLogo: mocks.fetchWorkspaceLogo,
    LOGO_FETCH_DEADLINE_MS: 10_000,
}))

const originalEnv = { ...process.env }
let root: string, runtime: DesktopRuntime
function previewRequest(link: unknown, { session = true, contentType = 'application/json', signal }: { session?: boolean; contentType?: string; signal?: AbortSignal } = {}) {
    const headers: Record<string, string> = { host: new URL(runtime.app.origin).host, origin: runtime.app.origin }
    if (contentType) headers['content-type'] = contentType
    if (session) headers.cookie = `rerun-desktop-session=${runtime.app.sessionToken}`
    return new Request(`${runtime.app.origin}/api/desktop/workspace/logo-preview`, { method: 'POST', headers, body: JSON.stringify({ link }), signal })
}
const post = (link: unknown, options?: Parameters<typeof previewRequest>[1]) => POST(previewRequest(link, options))
const ok = (bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), contentType = 'image/png') =>
    ({ ok: true as const, bytes, contentType })

beforeEach(async () => {
    mocks.fetchWorkspaceLogo.mockReset()
    root = await mkdtemp(join(tmpdir(), 'rerun-logo-preview-'))
    runtime = { protocolVersion: 1, launchNonce: 'logo-preview-launch', buildId: 'logo-preview', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3198', sessionToken: 'p'.repeat(48) }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused-local-fixture' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
})
afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('returns the validated raster bytes for a site link via the favicon service, persisting nothing', async () => {
    mocks.fetchWorkspaceLogo.mockResolvedValue(ok())
    const response = await post('acme.com')
    expect(mocks.fetchWorkspaceLogo).toHaveBeenCalledTimes(1)
    expect(mocks.fetchWorkspaceLogo).toHaveBeenCalledWith('https://www.google.com/s2/favicons?sz=128&domain=acme.com', expect.any(AbortSignal))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
})

test('passes a direct image link through unchanged', async () => {
    mocks.fetchWorkspaceLogo.mockResolvedValue(ok(new Uint8Array([1, 2, 3]), 'image/webp'))
    const response = await post('https://acme.com/logo.webp')
    expect(mocks.fetchWorkspaceLogo).toHaveBeenCalledWith('https://acme.com/logo.webp', expect.any(AbortSignal))
    expect(response.headers.get('content-type')).toBe('image/webp')
})

test('maps fetch refusals to their status and message', async () => {
    mocks.fetchWorkspaceLogo.mockResolvedValue({ ok: false, status: 404, error: NO_LOGO_FOUND })
    expect((await post('acme.com')).status).toBe(404)
    expect(await (await post('acme.com')).json()).toEqual({ error: NO_LOGO_FOUND })
    mocks.fetchWorkspaceLogo.mockResolvedValue({ ok: false, status: 413, error: LOGO_TOO_LARGE })
    expect((await post('acme.com')).status).toBe(413)
    expect(await (await post('acme.com')).json()).toEqual({ error: LOGO_TOO_LARGE })
    mocks.fetchWorkspaceLogo.mockResolvedValue({ ok: false, status: 415, error: 'Use a PNG, JPEG or WebP image link.' })
    expect((await post('acme.com')).status).toBe(415)
})

test('never calls the fetch for a link that does not read as a site or image', async () => {
    for (const link of ['', '   ', 'acme', 'acme.c', 'localhost', 'ftp://acme.com/logo.png']) {
        expect((await post(link)).status).toBe(400)
        expect(await (await post(link)).json()).toEqual({ error: NO_LOGO_FOUND })
    }
    expect(mocks.fetchWorkspaceLogo).not.toHaveBeenCalled()
})

test('rejects a malformed or oversized request body without fetching', async () => {
    expect((await post('acme.com', { contentType: 'multipart/form-data' })).status).toBe(415)
    expect((await post(undefined, { contentType: 'application/json' })).status).toBe(400)
    const oversized = { link: 'x'.repeat(9000) }
    const request = new Request(`${runtime.app.origin}/api/desktop/workspace/logo-preview`, {
        method: 'POST', headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin,
            cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(oversized),
    })
    expect((await POST(request)).status).toBe(413)
    expect(mocks.fetchWorkspaceLogo).not.toHaveBeenCalled()
})

test('requires the desktop session', async () => {
    expect((await post('acme.com', { session: false })).status).toBe(401)
    expect(mocks.fetchWorkspaceLogo).not.toHaveBeenCalled()
})

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

test.each(['abort', 'deadline'] as const)('a stalled body is bounded by %s even when stream cancellation never finishes', async kind => {
    vi.useFakeTimers()
    const stop = new AbortController(), reading = deferred<void>(), body = deferred<ReadableStreamReadResult<Uint8Array>>()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const request = previewRequest('acme.com', { signal: stop.signal })
    Object.defineProperty(request, 'body', { value: { getReader: () => ({
        read: () => { reading.resolve(); return body.promise }, cancel, releaseLock: vi.fn(),
    }) } })
    const response = POST(request)
    await reading.promise
    if (kind === 'abort') stop.abort()
    else await vi.advanceTimersByTimeAsync(10_000)
    expect((await response).status).toBe(kind === 'abort' ? 499 : 408)
    expect(cancel).toHaveBeenCalledTimes(1)
    body.resolve({ done: false, value: new TextEncoder().encode('{"link":"acme.com"}') })
    await Promise.resolve()
    expect(mocks.fetchWorkspaceLogo).not.toHaveBeenCalled()
})

test('request cancellation reaches an in-flight fetch and refuses its late success', async () => {
    const stop = new AbortController(), entered = deferred<AbortSignal>(), late = deferred<ReturnType<typeof ok>>()
    mocks.fetchWorkspaceLogo.mockImplementationOnce((_url: string, signal: AbortSignal) => { entered.resolve(signal); return late.promise })
    const response = POST(previewRequest('acme.com', { signal: stop.signal }))
    const upstream = await entered.promise
    stop.abort()
    expect(upstream.aborted).toBe(true)
    expect((await response).status).toBe(499)
    late.resolve(ok())
    await Promise.resolve()
    expect(mocks.fetchWorkspaceLogo).toHaveBeenCalledTimes(1)
})

test('oversized streamed input is refused without awaiting an uncooperative cancel', async () => {
    const request = previewRequest('acme.com')
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    Object.defineProperty(request, 'body', { value: { getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(8193) }), cancel, releaseLock: vi.fn(),
    }) } })
    expect((await POST(request)).status).toBe(413)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(mocks.fetchWorkspaceLogo).not.toHaveBeenCalled()
})

test('late body and cleanup rejections are observed after cancellation', async () => {
    const stop = new AbortController(), entered = deferred<void>(), body = deferred<ReadableStreamReadResult<Uint8Array>>()
    const request = previewRequest('acme.com', { signal: stop.signal })
    Object.defineProperty(request, 'body', { value: { getReader: () => ({
        read: () => { entered.resolve(); return body.promise }, cancel: async () => { throw new Error('late cancel') }, releaseLock: vi.fn(),
    }) } })
    const response = POST(request)
    await entered.promise
    stop.abort()
    expect((await response).status).toBe(499)
    body.reject(new Error('late read'))
    await Promise.resolve(); await Promise.resolve()
    expect(mocks.fetchWorkspaceLogo).not.toHaveBeenCalled()
})
