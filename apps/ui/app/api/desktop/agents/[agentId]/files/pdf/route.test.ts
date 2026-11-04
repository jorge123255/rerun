import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, utimes, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GET as read } from '../read/route'
import { GET as imageRoute } from '../image/route'
import { GET as audioRoute } from '../audio/route'
import { GET as videoRoute } from '../video/route'
import { GET as list, POST as upload } from '../route'
import { DESKTOP_PDF_MAX_BYTES } from '@/lib/desktop/server/pdf-bytes'
import { bindCoworkerPdfFolder, readCoworkerPdf } from '@/lib/desktop/server/pdf-read'
import { hashText } from '@/lib/files/editable'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { withRosterWrite } from '@/lib/desktop/server/roster-writes'
import { GET } from './route'

const raster = vi.hoisted(() => ({ render: vi.fn() }))
const fileHooks = vi.hoisted(() => ({ wrapRead: undefined as undefined | ((target: string, handle: FileHandle) => FileHandle) }))
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        return fileHooks.wrapRead ? fileHooks.wrapRead(String(args[0]), handle) : handle
    } }
})
vi.mock('@/lib/desktop/server/pdf-render', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/desktop/server/pdf-render')>(), renderDesktopPdf: raster.render,
}))

function u16(value: number) {
    return Buffer.from([value & 255, (value >> 8) & 255])
}
function u32le(value: number) {
    return Buffer.from([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255])
}
function u32(value: number) {
    return Buffer.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}
function box(type: string, payload: Buffer) {
    return Buffer.concat([u32(8 + payload.length), Buffer.from(type), payload])
}
function ftyp(major: string, compatible: string[] = []) {
    return box('ftyp', Buffer.concat([Buffer.from(major), u32(0), ...compatible.map(brand => Buffer.from(brand))]))
}
function hdlr(handler: string) {
    const payload = Buffer.alloc(24)
    payload.set(Buffer.from(handler), 8)
    return box('hdlr', payload)
}
function mp4() {
    const movie = box('moov', box('trak', box('mdia', hdlr('vide'))))
    return Buffer.concat([ftyp('isom', ['mp42']), movie, box('mdat', Buffer.from([0]))])
}
function wav() {
    const fmt = Buffer.concat([u16(1), u16(1), u32le(8000), u32le(8000), u16(1), u16(8)])
    const chunks = Buffer.concat([Buffer.from('fmt '), u32le(fmt.length), fmt, Buffer.from('data'), u32le(2), Buffer.from([0x80, 0x80])])
    return Buffer.concat([Buffer.from('RIFF'), u32le(4 + chunks.length), Buffer.from('WAVE'), chunks])
}
function pdf(version = '1.4', body = '1 0 obj<<>>endobj\ntrailer<<>>\n') {
    return Buffer.from(`%PDF-${version}\n${body}%%EOF\n`)
}

const deck = pdf()
const clip = mp4()
const tone = wav()
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const html = '<!doctype html><script>alert(1)</script>'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3197'
const token = 'e'.repeat(48)
let root: string
let alice: string
let bob: string
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')

function request(id: string, suffix: string, cookie = token, extra: Record<string, string> = {}) {
    return new Request(`${origin}/api/desktop/agents/${id}/files/pdf${suffix}`, {
        headers: { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${cookie}`, ...extra },
    })
}
const preview = (path: string, identity?: string, id = alice) => {
    const query = new URLSearchParams({ path })
    if (identity !== undefined) query.set('identity', identity)
    return GET(request(id, `?${query}`), { params: Promise.resolve({ agentId: id }) })
}
const listing = (path = 'docs', id = alice) => list(new Request(`${origin}/api/desktop/agents/${id}/files?path=${encodeURIComponent(path)}`, {
    headers: { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${token}` },
}), { params: Promise.resolve({ agentId: id }) })

beforeEach(async () => {
    fileHooks.wrapRead = undefined
    raster.render.mockReset().mockImplementation(async (_bytes: Uint8Array, options: { page: number }) => ({
        page: options.page, pageCount: 2, width: 1, height: 1, pageWidth: 612, pageHeight: 792, png: new Uint8Array(png),
    }))
    root = await mkdtemp(join(tmpdir(), 'rerun-pdf-api-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'pdf', buildId: 'pdf-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    for (const [id, text] of [['engine-alice', 'Alice bytes'], ['engine-bob', 'Bob bytes']] as const) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
    }
    await writeFile(join(workspace('engine-alice'), 'docs', 'deck.pdf'), deck)
    await writeFile(join(workspace('engine-alice'), 'docs', 'tone.wav'), tone)
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.png'), png)
    await writeFile(join(workspace('engine-alice'), 'docs', 'clip.mp4'), clip)
    await writeFile(join(workspace('engine-alice'), 'docs', 'page.pdf'), html)
    await writeFile(join(workspace('engine-alice'), 'docs', 'notes.pdf'), 'Alice bytes')
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.pdf'), png)
    await writeFile(join(workspace('engine-alice'), 'docs', 'tone.pdf'), tone)
    await writeFile(join(workspace('engine-alice'), 'docs', 'clip.pdf'), clip)
    await writeFile(join(workspace('engine-alice'), 'docs', 'future.pdf'), pdf('3.0'))
    await writeFile(join(workspace('engine-alice'), 'docs', 'broken.pdf'), Buffer.from('%PDF-1.4\ntrailer'))
    await writeFile(join(workspace('engine-alice'), 'docs', 'empty.pdf'), Buffer.alloc(0))
    await mkdir(join(workspace('engine-alice'), 'docs', 'folder.pdf'))
    await writeFile(join(workspace('engine-bob'), 'docs', 'deck.pdf'), html)
})

afterEach(async () => {
    fileHooks.wrapRead = undefined
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

function interceptPdfReads(afterRead: (number: number) => Promise<void> | void) {
    let reads = 0, closes = 0
    fileHooks.wrapRead = (target, handle) => {
        if (!target.endsWith('/deck.pdf')) return handle
        const read = handle.read.bind(handle), close = handle.close.bind(handle)
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
            const result = await read(buffer, offset, Math.min(length, 8), position)
            await afterRead(++reads)
            return result
        }) as FileHandle['read']
        handle.close = async () => { closes++; await close() }
        return handle
    }
    return { get reads() { return reads }, get closes() { return closes } }
}

test('same-inode, same-length edits during the PDF read never reach the renderer', async () => {
    const target = join(workspace('engine-alice'), 'docs', 'deck.pdf')
    const before = await lstat(target, { bigint: true })
    const replacement = Buffer.from(deck)
    replacement[replacement.indexOf('1 0 obj')] = '2'.charCodeAt(0)
    const observed = interceptPdfReads(async count => {
        if (count !== 1) return
        await writeFile(target, replacement)
        // A deterministic changed timestamp avoids depending on the test clock's resolution.
        await utimes(target, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'))
    })
    const response = await preview('docs/deck.pdf', `${before.dev}:${before.ino}`)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'This PDF changed while it was being read.' })
    const after = await lstat(target, { bigint: true })
    expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size)
    expect(after.mtimeNs).not.toBe(before.mtimeNs)
    expect(await readFile(target)).toEqual(replacement)
    expect(observed.reads).toBeGreaterThan(1); expect(observed.closes).toBe(1)
    expect(raster.render).not.toHaveBeenCalled()
})

test('a hard link arriving during a PDF read invalidates the snapshot', async () => {
    const target = join(workspace('engine-alice'), 'docs', 'deck.pdf')
    const alias = join(workspace('engine-alice'), 'docs', 'late-alias.pdf')
    const observed = interceptPdfReads(async count => { if (count === 1) await link(target, alias) })
    const response = await preview('docs/deck.pdf')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'This PDF changed while it was being read.' })
    expect((await lstat(target, { bigint: true })).nlink).toBe(BigInt(2))
    expect(await readFile(target)).toEqual(deck); expect(await readFile(alias)).toEqual(deck)
    expect(observed.closes).toBe(1)
    expect(raster.render).not.toHaveBeenCalled()
})

test('a queued PDF read canceled before roster admission performs no recovery or file read', async () => {
    const runtime = await readDesktopRuntime()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = withRosterWrite(async () => { entered(); await gate })
    await started
    const recover = vi.fn(async () => {})
    const restore = bindCoworkerPdfFolder({ recoverInterruptedEdits: recover, claimed: () => false })
    const observed = interceptPdfReads(() => {})
    const controller = new AbortController()
    let pending: Promise<unknown> | undefined
    try {
        pending = readCoworkerPdf(runtime, alice, 'docs/deck.pdf', undefined, controller.signal)
        const rejected = expect(pending).rejects.toMatchObject({ status: 499 })
        controller.abort()
        release()
        await held; await rejected
        expect(recover).not.toHaveBeenCalled()
        expect(observed.reads).toBe(0)
        expect(raster.render).not.toHaveBeenCalled()
    } finally {
        release(); await held; await pending?.catch(() => {}); restore()
    }
})

test('a route canceled during its PDF read stops before another read and closes its handle', async () => {
    const controller = new AbortController()
    const observed = interceptPdfReads(() => controller.abort())
    const req = new Request(request(alice, '?path=docs/deck.pdf'), { signal: controller.signal })
    const response = await GET(req, { params: Promise.resolve({ agentId: alice }) })
    expect(response.status).toBe(499)
    expect(await response.json()).toEqual({ error: 'PDF preview was closed.' })
    expect(observed.reads).toBe(1); expect(observed.closes).toBe(1)
    expect(raster.render).not.toHaveBeenCalled()
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'deck.pdf'))).toEqual(deck)
    fileHooks.wrapRead = undefined
    expect((await preview('docs/deck.pdf')).status).toBe(200)
})

test('renders one owned PDF as an inert PNG and refuses other bytes, paths, and coworkers', async () => {
    expect((await GET(request(alice, '?path=docs/deck.pdf', ''), { params: Promise.resolve({ agentId: alice }) })).status).toBe(401)
    const listed = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
    const identity = listed.find(entry => entry.name === 'deck.pdf')?.identity
    const stat = await lstat(join(workspace('engine-alice'), 'docs', 'deck.pdf'), { bigint: true })
    expect(identity).toBe(`${stat.dev}:${stat.ino}`)

    const ok = await preview('docs/deck.pdf', identity)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('content-disposition')).toBeNull()
    expect(ok.headers.get('x-pdf-page')).toBe('1')
    expect(ok.headers.get('x-pdf-pages')).toBe('2')
    expect(ok.headers.get('x-pdf-width')).toBe('1')
    expect(ok.headers.get('x-pdf-height')).toBe('1')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(png)
    expect(Buffer.from(raster.render.mock.calls[0]![0])).toEqual(deck)

    const ranged = await GET(request(alice, '?path=docs/deck.pdf', token, { range: 'bytes=0-3' }), { params: Promise.resolve({ agentId: alice }) })
    expect(ranged.status).toBe(200)
    expect(ranged.headers.get('content-type')).toBe('image/png')
    expect(ranged.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(png)

    for (const path of ['docs/page.pdf', 'docs/notes.pdf', 'docs/shot.pdf', 'docs/tone.pdf', 'docs/clip.pdf']) {
        const refused = await preview(path)
        expect(refused.status, path).toBe(415)
        expect(refused.headers.get('content-type')).toContain('application/json')
        const body = await refused.text()
        expect(body.includes('<script') || body.includes('Alice bytes') || body.includes('PNG') || body.includes('RIFF') || body.includes('ftyp')).toBe(false)
    }
    expect((await (await preview('docs/future.pdf')).json()).error).toBe('This PDF format can’t be previewed.')
    expect((await (await preview('docs/broken.pdf')).json()).error).toBe('This PDF is damaged and can’t be previewed.')
    expect((await (await preview('docs/empty.pdf')).json()).error).toBe('This PDF is damaged and can’t be previewed.')
    expect((await (await preview('docs/page.pdf')).json()).error).toBe('This file is not a supported PDF.')
    expect((await preview('docs/notes.md')).status).toBe(415)
    expect((await preview('docs/clip.mp4')).status).toBe(415)
    expect((await preview('docs/folder.pdf')).status).toBe(400)

    expect((await preview('../engine-bob/workspace/docs/deck.pdf')).status).toBe(400)
    expect((await preview('docs/../../engine-bob/workspace/docs/deck.pdf')).status).toBe(400)
    expect((await preview('docs/missing.pdf')).status).toBe(404)
    expect((await preview('')).status).toBe(400)
    expect((await preview('docs/deck.pdf', 'nope')).status).toBe(400)

    await symlink(join(workspace('engine-alice'), 'docs', 'deck.pdf'), join(workspace('engine-alice'), 'docs', 'alias.pdf'))
    await symlink(join(workspace('engine-bob'), 'docs', 'deck.pdf'), join(workspace('engine-alice'), 'docs', 'outside.pdf'))
    await symlink(join(workspace('engine-alice'), 'docs'), join(workspace('engine-alice'), 'linkdir'))
    for (const path of ['docs/alias.pdf', 'docs/outside.pdf', 'linkdir/deck.pdf']) {
        const refused = await preview(path)
        expect(refused.status, path).toBe(400)
        expect(await refused.text()).not.toContain('%PDF')
    }
    expect((await preview('docs/deck.pdf', identity)).status).toBe(200)
    expect((await preview('docs/deck.pdf', undefined, bob)).status).toBe(415)
    expect((await preview('docs/missing.pdf', undefined, bob)).status).toBe(404)

    await writeFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-deck.pdf'), deck)
    expect((await preview('docs/.rerun-edit-deck.pdf')).status).toBe(400)
    expect(await readFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-deck.pdf'))).toEqual(deck)
})

test('page and zoom reach the raster helper, and invalid options are refused before rendering', async () => {
    const response = await GET(request(alice, '?path=docs/deck.pdf&page=2&scale=1.5'), { params: Promise.resolve({ agentId: alice }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-pdf-page')).toBe('2')
    expect(response.headers.get('x-pdf-page-width')).toBe('612')
    expect(response.headers.get('x-pdf-page-height')).toBe('792')
    expect(raster.render).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ page: 2, scale: 1.5, signal: expect.anything() }))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
    raster.render.mockClear()
    for (const query of ['page=0', 'page=10001', 'page=1.5', 'scale=0.49', 'scale=2.01', 'scale=NaN']) {
        const refused = await GET(request(alice, `?path=docs/deck.pdf&${query}`), { params: Promise.resolve({ agentId: alice }) })
        expect(refused.status).toBe(400)
    }
    expect(raster.render).not.toHaveBeenCalled()
})

test('a renderer refusal returns a visible error without any PDF or partial PNG bytes', async () => {
    raster.render.mockRejectedValueOnce(new DesktopHttpError(422, 'Could not display this PDF page.'))
    const response = await preview('docs/deck.pdf')
    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'Could not display this PDF page.' })
})

test('a changed coworker identity while rendering cannot receive the completed raster', async () => {
    raster.render.mockImplementationOnce(async () => {
        const db = await openDesktopDatabase(root)
        await db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id = ? WHERE id = ?', args: ['engine-replaced', alice] })
        return { page: 1, pageCount: 2, width: 1, height: 1, pageWidth: 612, pageHeight: 792, png }
    })
    const response = await preview('docs/deck.pdf')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'Coworker not found' })
})

test('a request aborted before reading starts never reaches the renderer', async () => {
    const controller = new AbortController()
    controller.abort()
    const req = new Request(request(alice, '?path=docs/deck.pdf'), { signal: controller.signal })
    const response = await GET(req, { params: Promise.resolve({ agentId: alice }) })
    expect(response.status).toBe(499)
    expect(raster.render).not.toHaveBeenCalled()
})

test('a direct PDF read finishes real interrupted publication cleanup without a prior Files listing', async () => {
    const directory = join(workspace('engine-alice'), 'docs')
    const target = join(directory, 'deck.pdf')
    const before = await lstat(target, { bigint: true })
    const identity = `${before.dev}:${before.ino}`
    const backup = '.rerun-backup-pdf-fixture'
    const temp = '.rerun-edit-pdf-fixture'
    const journal = '.rerun-publish-pdf-fixture.json'
    // A committed publication stopped after retiring its backup, before retiring the temp alias
    // and journal. Without the real recovery the reader must refuse the extra hard link.
    await link(target, join(directory, temp))
    expect((await lstat(target, { bigint: true })).nlink).toBe(BigInt(2))
    await writeFile(join(directory, journal), JSON.stringify({
        v: 1, final: 'deck.pdf', temp, backup, phase: 'linked', baseHash: hashText(deck.toString('utf8')),
    }), { mode: 0o600 })

    // No probe binding and no call to listing(): this exercises the production shared closures.
    const response = await preview('docs/deck.pdf', identity)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
    expect(Buffer.from(raster.render.mock.calls[0]![0])).toEqual(deck)
    const after = await lstat(target, { bigint: true })
    expect(`${after.dev}:${after.ino}`).toBe(identity)
    expect(after.nlink).toBe(BigInt(1))
    const names = await readdir(directory)
    for (const name of [backup, temp, journal]) expect(names).not.toContain(name)
    expect(await readFile(target)).toEqual(deck)
    expect((await preview('docs/deck.pdf', identity)).status).toBe(200)
})

test('folder recovery finishes before the PDF bytes are read', async () => {
    const healed = pdf('1.7', '2 0 obj<<>>endobj\ntrailer<<>>\n')
    const target = join(workspace('engine-alice'), 'docs', 'deck.pdf')
    const parent = await realpath(join(workspace('engine-alice'), 'docs'))
    let recovered = false
    const restore = bindCoworkerPdfFolder({
        recoverInterruptedEdits: async directory => {
            expect(directory).toBe(parent)
            expect(await readFile(target)).toEqual(deck)
            await writeFile(target, healed)
            recovered = true
        },
        claimed: (directory, name) => {
            expect(recovered).toBe(true)
            expect(directory).toBe(parent)
            expect(name).toBe('deck.pdf')
            return false
        },
    })
    try {
        const ok = await preview('docs/deck.pdf')
        expect(ok.status).toBe(200)
        expect(Buffer.from(await ok.arrayBuffer())).toEqual(png)
        expect(Buffer.from(raster.render.mock.calls[0]![0])).toEqual(healed)
    } finally { restore() }
})

test('a name claimed by an in-progress save is left unopened', async () => {
    const target = join(workspace('engine-alice'), 'docs', 'deck.pdf')
    const restore = bindCoworkerPdfFolder({
        recoverInterruptedEdits: async () => {},
        claimed: () => true,
    })
    try {
        const refused = await preview('docs/deck.pdf')
        expect(refused.status).toBe(409)
        expect(await refused.json()).toEqual({ error: 'This file is being saved. Try the preview again once that finishes.' })
        expect(await readFile(target)).toEqual(deck)
    } finally { restore() }
})

test('a changed inode is not served, and a damaged or oversized PDF is not returned as bytes', async () => {
    const identity = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries.find(entry => entry.name === 'deck.pdf')?.identity
    const target = join(workspace('engine-alice'), 'docs', 'deck.pdf')
    await rename(target, target + '.hold')
    await writeFile(target, html)
    const replaced = await preview('docs/deck.pdf', identity)
    expect(replaced.status).toBe(409)
    expect(await replaced.text()).not.toContain('%PDF')
    expect(await readFile(target, 'utf8')).toBe(html)
    expect((await preview('docs/deck.pdf')).status).toBe(415)

    await writeFile(join(workspace('engine-alice'), 'docs', 'huge.pdf'), Buffer.alloc(DESKTOP_PDF_MAX_BYTES + 1))
    const huge = await preview('docs/huge.pdf')
    expect(huge.status).toBe(413)
    expect((await huge.json()).error).toBe('PDF files can be up to 16 MB.')
    expect(Number(huge.headers.get('content-length'))).toBeLessThan(200)

    const keep = join(workspace('engine-alice'), 'docs', 'keep.pdf')
    await writeFile(keep, deck)
    const extra = join(workspace('engine-alice'), 'docs', 'extra.pdf')
    await link(keep, extra)
    expect((await preview('docs/keep.pdf')).status).toBe(400)
    expect((await preview('docs/extra.pdf')).status).toBe(400)
    await unlink(extra)
    expect((await preview('docs/keep.pdf')).status).toBe(200)
})

test('text read, image preview, audio preview, video preview, and text import stay on their own contracts', async () => {
    const headers = { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${token}` }
    const text = await read(new Request(`${origin}/api/desktop/agents/${alice}/files/read?path=docs/notes.md`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(text.status).toBe(200)
    expect(await text.json()).toMatchObject({ path: 'docs/notes.md', content: 'Alice bytes', truncated: false })

    const image = await imageRoute(new Request(`${origin}/api/desktop/agents/${alice}/files/image?path=docs/shot.png`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    const imageOfPdf = await imageRoute(new Request(`${origin}/api/desktop/agents/${alice}/files/image?path=docs/deck.pdf`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(imageOfPdf.status).toBe(415)
    expect(await imageOfPdf.text()).not.toContain('%PDF')

    const audio = await audioRoute(new Request(`${origin}/api/desktop/agents/${alice}/files/audio?path=docs/tone.wav`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(audio.status).toBe(200)
    expect(audio.headers.get('content-type')).toBe('audio/wav')

    const video = await videoRoute(new Request(`${origin}/api/desktop/agents/${alice}/files/video?path=docs/clip.mp4`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(video.status).toBe(200)
    expect(video.headers.get('content-type')).toBe('video/mp4')

    const pdfForm = new FormData()
    pdfForm.set('path', 'docs')
    pdfForm.set('file', new File([deck], 'incoming.pdf'))
    const imported = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: pdfForm, headers,
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(imported.status).toBe(415)
    expect(await readdir(join(workspace('engine-alice'), 'docs'))).not.toContain('incoming.pdf')

    const textForm = new FormData()
    textForm.set('path', 'docs')
    textForm.set('file', new File(['# note'], 'brief.md'))
    const saved = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: textForm, headers,
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(saved.status).toBe(201)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'brief.md'), 'utf8')).toBe('# note')
})
