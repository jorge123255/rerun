import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
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
import { GET as download } from '../download/route'
import { GET as listing } from '../route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189'
const token = 's'.repeat(48)
let root: string

beforeEach(async () => {
    // Shared files refuse a symbolic link anywhere in their path, and macOS keeps its temporary folder behind one.
    root = await mkdtemp(join(await realpath(tmpdir()), 'rerun-shared-media-route-'))
    const installId = '0890b231-7957-4d86-9a31-1ab2bdb9482f'
    const dataRoot = join(root, 'workspaces', '2')
    const engineRoot = join(dataRoot, 'engine')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_INSTALL_DIR: root, RERUN_DESKTOP_DATA_DIR: dataRoot, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await mkdir(join(engineRoot, 'shared'), { recursive: true })
    await writeFile(join(engineRoot, 'desktop-owner.json'), JSON.stringify({ installId, workspaceId: 2 }), { mode: 0o600 })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'shared', buildId: 'shared-test', workspaceId: 2, installId, installRoot: root, dataRoot, engineRoot, app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }), { mode: 0o600 })
})
afterEach(async () => { process.env = { ...env }; await rm(root, { recursive: true, force: true }) })

function request(path: string) {
    return new Request(`${origin}/api/desktop/shared-files${path}`, { headers: { host: new URL(origin).host, origin, cookie: `rerun-desktop-session=${token}` } })
}

test('shared media returns exact bytes and a hash for Save As, not a hosted URL', async () => {
    const bytes = onePixelPng()
    await writeFile(join(root, 'workspaces', '2', 'engine', 'shared', 'pixel.png'), bytes)
    const response = await media(request('/media?path=pixel.png'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes))
    const identity = response.headers.get('x-rerun-shared-sha256')
    expect(identity).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(join(root, 'workspaces', '2', 'engine', 'shared', 'pixel.png'), 'replaced')
    expect((await media(request(`/media?path=pixel.png&download=1&identity=${identity}`))).status).toBe(409)
})

test('PDF page and text are derived from the same exact document hash', async () => {
    await writeFile(join(root, 'workspaces', '2', 'engine', 'shared', 'doc.pdf'), '%PDF-1.4\n1 0 obj\nendobj\n%%EOF')
    const page = await pdf(request('/pdf?path=doc.pdf&page=1&scale=1'))
    expect(page.status).toBe(200)
    expect(page.headers.get('x-pdf-sha256')).toMatch(/^[a-f0-9]{64}$/)
    const text = await pdfText(request(`/pdf-text?path=doc.pdf&sha256=${page.headers.get('x-pdf-sha256')}`))
    expect(text.status).toBe(200)
    expect(text.headers.get('x-pdf-sha256')).toBe(page.headers.get('x-pdf-sha256'))
    expect(new TextDecoder().decode(await text.arrayBuffer())).not.toContain('%PDF')
})

test('the native download requires an authenticated workspace and returns only the listed version', async () => {
    const dir = join(root, 'workspaces', '2', 'engine', 'shared')
    const path = "Bob's report.zip", bytes = Uint8Array.of(21, 22, 23)
    await writeFile(join(dir, path), bytes)
    const { entries } = await (await listing(request(''))).json()
    const version = entries.find((entry: { name: string }) => entry.name === path)?.deleteRevision
    const url = '/download?' + new URLSearchParams({ path, version, workspaceId: '2' })
    const unsigned = request(url)
    unsigned.headers.delete('cookie')
    expect((await download(unsigned)).status).toBe(401)
    expect((await download(request(url.replace('workspaceId=2', 'workspaceId=1')))).status).toBe(409)
    expect((await download(request(url + '&path=extra'))).status).toBe(400)
    expect((await download(request(url + '&identity=' + 'f'.repeat(64)))).status).toBe(409)
    const response = await download(request(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''Bob%27s%20report.zip")
    expect(response.headers.get('x-rerun-shared-version')).toBe(version)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    await rename(join(dir, path), join(dir, 'original.zip'))
    await writeFile(join(dir, path), bytes)
    expect((await download(request(url))).status).toBe(409)
})
