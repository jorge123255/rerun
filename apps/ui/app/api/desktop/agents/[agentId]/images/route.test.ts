import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { composerTestPng } from '@/lib/desktop/server/composer-image.test-fixtures'
import { DESKTOP_IMAGE_MAX_BYTES } from '@/lib/desktop/server/image-bytes'
import type { DesktopImageSnapshot } from '@/lib/desktop/composer-image'
import { GET, POST } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3198'
const token = 'e'.repeat(48)
let root: string, alice: string, bob: string
const headers = (cookie = token) => ({ host: '127.0.0.1:3198', origin, cookie: `rerun-desktop-session=${cookie}` })
const context = (agentId = alice) => ({ params: Promise.resolve({ agentId }) })
const preview = (image: unknown, agentId = alice, cookie = token) => GET(new Request(`${origin}/api/desktop/agents/${agentId}/images?snapshot=${encodeURIComponent(JSON.stringify(image))}`, { headers: headers(cookie) }), context(agentId))
async function upload(name = 'shot.png') {
    const form = new FormData()
    form.set('file', new File([new Uint8Array(composerTestPng())], name, { type: 'image/png' }))
    form.set('path', '')
    return POST(new Request(`${origin}/api/desktop/agents/${alice}/images`, { method: 'POST', headers: headers(), body: form }), context())
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-composer-image-api-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'image-upload', buildId: 'image-upload-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('uploads and previews the exact owned snapshot with private image response headers', async () => {
    const uploaded = await upload()
    expect(uploaded.status).toBe(201)
    const { image } = await uploaded.json() as { image: DesktopImageSnapshot }
    const response = await preview(image)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(composerTestPng())
    expect((await upload()).status).toBe(409)
})

test('preview refuses metadata mismatch, another coworker, signed-out requests and extra query fields', async () => {
    const { image } = await (await upload()).json() as { image: DesktopImageSnapshot }
    expect((await preview({ ...image, width: 2 })).status).toBe(409)
    expect((await preview(image, bob)).status).toBe(404)
    expect((await preview(image, alice, 'wrong')).status).toBe(401)
    expect((await preview({ ...image, path: '../outside.png' })).status).toBe(400)
    expect((await GET(new Request(`${origin}/api/desktop/agents/${alice}/images?snapshot=${encodeURIComponent(JSON.stringify(image))}&path=outside.png`, { headers: headers() }), context())).status).toBe(400)
})

test('multipart size is bounded before parsing and extra fields are refused', async () => {
    const tooLarge = new Request(`${origin}/api/desktop/agents/${alice}/images`, { method: 'POST', headers: { ...headers(), 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(DESKTOP_IMAGE_MAX_BYTES + 65537) }, body: 'x' })
    expect((await POST(tooLarge, context())).status).toBe(413)
    const form = new FormData()
    form.set('file', new File([new Uint8Array(composerTestPng())], 'shot.png'))
    form.set('surprise', 'not accepted')
    expect((await POST(new Request(`${origin}/api/desktop/agents/${alice}/images`, { method: 'POST', headers: headers(), body: form }), context())).status).toBe(400)
})
