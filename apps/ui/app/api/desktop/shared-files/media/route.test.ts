import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { onePixelPng } from '@/lib/desktop/server/shared-file-previews/test-helpers'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/desktop/server/pdf-render', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/desktop/server/pdf-render')>()
    return { ...actual, renderDesktopPdf: async () => ({ page: 1, pageCount: 1, width: 1, height: 1, pageWidth: 1, pageHeight: 1, png: onePixelPng() }) }
})
vi.mock('@/lib/desktop/server/pdf-text', () => ({ extractDesktopPdfText: async () => ({ pageCount: 1, truncated: false, reason: null, pages: [{ page: 1, text: 'Shared PDF', rotation: 0, pageWidth: 1, pageHeight: 1, crop: null, runs: [] }] }) }))

import { GET as media } from './route'
import { GET as pdf } from '../pdf/route'
import { GET as pdfText } from '../pdf-text/route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189'
const token = 's'.repeat(48)
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-shared-media-route-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'shared', buildId: 'shared-test', workspaceId: 2, dataRoot: root, engineRoot: join(root, 'engine'), app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }), { mode: 0o600 })
    await mkdir(join(root, 'engine', 'shared'), { recursive: true })
})
afterEach(async () => { process.env = { ...env }; await rm(root, { recursive: true, force: true }) })

function request(path: string) {
    return new Request(`${origin}/api/desktop/shared-files${path}`, { headers: { host: new URL(origin).host, origin, cookie: `rerun-desktop-session=${token}` } })
}

test('shared media returns exact bytes and a hash for Save As, not a hosted URL', async () => {
    const bytes = onePixelPng()
    await writeFile(join(root, 'engine', 'shared', 'pixel.png'), bytes)
    const response = await media(request('/media?path=pixel.png'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes))
    const identity = response.headers.get('x-rerun-shared-sha256')
    expect(identity).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(join(root, 'engine', 'shared', 'pixel.png'), 'replaced')
    expect((await media(request(`/media?path=pixel.png&download=1&identity=${identity}`))).status).toBe(409)
})

test('PDF page and text are derived from the same exact document hash', async () => {
    await writeFile(join(root, 'engine', 'shared', 'doc.pdf'), '%PDF-1.4\n1 0 obj\nendobj\n%%EOF')
    const page = await pdf(request('/pdf?path=doc.pdf&page=1&scale=1'))
    expect(page.status).toBe(200)
    expect(page.headers.get('x-pdf-sha256')).toMatch(/^[a-f0-9]{64}$/)
    const text = await pdfText(request(`/pdf-text?path=doc.pdf&sha256=${page.headers.get('x-pdf-sha256')}`))
    expect(text.status).toBe(200)
    expect(text.headers.get('x-pdf-sha256')).toBe(page.headers.get('x-pdf-sha256'))
    expect(new TextDecoder().decode(await text.arrayBuffer())).not.toContain('%PDF')
})
