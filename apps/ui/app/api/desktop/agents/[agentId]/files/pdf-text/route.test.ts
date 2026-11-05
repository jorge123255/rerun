import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET } from './route'

const extracted = vi.hoisted(() => ({ extract: vi.fn() }))
vi.mock('@/lib/desktop/server/pdf-text', () => ({ extractDesktopPdfText: extracted.extract }))

const deck = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
const text = {
    pageCount: 2, truncated: false, reason: '',
    pages: [
        { page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: 'Alpha one', runs: [{ start: 0, end: 5, x: 0.1, y: 0.2, w: 0.2, h: 0.03 }] },
        { page: 2, rotation: 90, crop: { x: 36, y: 36, width: 540, height: 720 }, pageWidth: 720, pageHeight: 540, text: 'Alpha two', runs: [{ start: 0, end: 5, x: 0.25, y: 0.3, w: 0.2, h: 0.04 }] },
    ],
}
const env = { ...process.env }
const origin = 'http://127.0.0.1:3197'
const token = 'e'.repeat(48)
let root: string
let alice: string
let bob: string
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')

function request(id: string, suffix: string, cookie = token) {
    return new Request(`${origin}/api/desktop/agents/${id}/files/pdf-text${suffix}`, {
        headers: { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${cookie}` },
    })
}
const read = (id: string, path: string, identity?: string, cookie = token) => {
    const query = new URLSearchParams({ path })
    if (identity !== undefined) query.set('identity', identity)
    return GET(request(id, `?${query}`, cookie), { params: Promise.resolve({ agentId: id }) })
}

beforeEach(async () => {
    extracted.extract.mockReset().mockResolvedValue(text)
    root = await mkdtemp(join(tmpdir(), 'rerun-pdf-text-api-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'pdf-text', buildId: 'pdf-text-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    await mkdir(join(workspace('engine-alice'), 'docs'), { recursive: true })
    await mkdir(join(workspace('engine-bob'), 'docs'), { recursive: true })
    await writeFile(join(workspace('engine-alice'), 'docs', 'deck.pdf'), deck)
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('returns positioned text for the owned file and passes only its bytes to the helper', async () => {
    const info = await lstat(join(workspace('engine-alice'), 'docs', 'deck.pdf'), { bigint: true })
    const identity = `${info.dev}:${info.ino}`
    const response = await read(alice, 'docs/deck.pdf', identity)
    const raw = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(raw).not.toContain('%PDF')
    expect(JSON.parse(raw)).toMatchObject({ identity, path: 'docs/deck.pdf', pageCount: 2, pages: [{ text: 'Alpha one' }, { rotation: 90, pageWidth: 720, pageHeight: 540 }] })
    expect(extracted.extract).toHaveBeenCalledTimes(1)
    const [bytes, options] = extracted.extract.mock.calls[0] as [Uint8Array, { signal: AbortSignal }]
    expect(Buffer.from(bytes)).toEqual(deck)
    expect(Object.keys(options)).toEqual(['signal'])
    expect(options.signal).toBeInstanceOf(AbortSignal)
})

test('an extra query, a replaced identity, another coworker, and a signed-out request do not extract text', async () => {
    const info = await lstat(join(workspace('engine-alice'), 'docs', 'deck.pdf'), { bigint: true })
    const identity = `${info.dev}:${info.ino}`
    const wrong = identity === '1:1' ? '2:2' : '1:1'
    expect((await GET(request(alice, '?path=missing.pdf&page=1'), { params: Promise.resolve({ agentId: alice }) })).status).toBe(400)
    expect((await read(alice, 'docs/deck.pdf', wrong)).status).toBe(409)
    expect((await read(bob, 'docs/deck.pdf')).status).toBe(404)
    expect((await read(alice, 'docs/deck.pdf', identity, 'nope')).status).toBe(401)
    const aborted = new AbortController()
    aborted.abort()
    const closed = await GET(new Request(`${origin}/api/desktop/agents/${alice}/files/pdf-text?path=docs%2Fdeck.pdf`, {
        headers: { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${token}` }, signal: aborted.signal,
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(closed.status).toBe(499)
    expect(await closed.json()).toMatchObject({ error: 'PDF text was closed.' })
    expect(extracted.extract).not.toHaveBeenCalled()
})
