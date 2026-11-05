import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GET, PUT, POST } from './route'

let root: string
const env = { ...process.env }
const origin = 'http://127.0.0.1:3191', token = 'b'.repeat(48)
const headers = { host: '127.0.0.1:3191', origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }
const context = (path: string[] = []) => ({ params: Promise.resolve({ path }) })
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-brain-route-')))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'brain-launch', buildId: 'brain-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:3192', apiKey: 'engine-test' } }), { mode: 0o600 })
})
afterEach(async () => { process.env = { ...env }; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
const get = (override: Record<string, string> = {}, path?: string[]) => GET(new Request(origin + '/api/desktop/brain/pages', { headers: { ...headers, ...override } }), context(path))
const put = (body: unknown, override: Record<string, string> = {}) => PUT(new Request(origin + '/api/desktop/brain/pages/company', { method: 'PUT', headers: { ...headers, ...override }, body: JSON.stringify(body) }), context(['company']))
const input = { title: 'Company', type: 'company', content: 'Private company facts', sources: [], baseHash: null }

it('authenticates before storage access and protects write origins', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not fetch'))
    expect((await get({ cookie: '' })).status).toBe(401)
    expect((await get({ host: 'outside.test' })).status).toBe(403)
    expect((await put(input, { origin: 'https://outside.test' })).status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
})
it('validates bounded input, slug and identity without relaying an engine request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not fetch'))
    expect((await put({ ...input, author: 'user:forged' })).status).toBe(400)
    expect((await put({ ...input, force: true })).status).toBe(400)
    expect((await put({ ...input, title: ' ' })).status).toBe(400)
    expect((await put({ ...input, content: 'x'.repeat(300_001) })).status).toBe(413)
    expect((await get({}, ['..'])).status).toBe(400)
    const restore = new Request(origin + '/api/desktop/brain/pages/company/revert/revision', { method: 'POST', headers, body: '{}' })
    expect((await POST(restore, context(['company', 'revert', 'revision']))).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
})
it('keeps missing/unavailable/conflict errors as errors, and uses the local engine with redirects disabled', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'missing' }), { status: 404 }))
    expect((await get({}, ['company'])).status).toBe(404)
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    expect((await get()).status).toBe(503)
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 409 }))
    expect((await put(input)).status).toBe(409)
    expect(fetcher.mock.calls.every(([url, options]) => String(url).startsWith('http://127.0.0.1:3192/desktop/brain/pages') && options?.redirect === 'error')).toBe(true)
    expect(fetcher.mock.calls.every(([, options]) => !(options?.body as string | undefined)?.includes('author'))).toBe(true)
})
it('returns original contract shapes and rejects oversized engine output', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"pages":[]}'))
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ pages: [] })
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(2_000_001)))
    expect((await get()).status).toBe(413)
})
