import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { GET as read } from '../read/route'
import { GET as imageRoute } from '../image/route'
import { GET as audioRoute } from '../audio/route'
import { GET as videoRoute } from '../video/route'
import { GET as list, POST as upload } from '../route'
import { DESKTOP_PDF_MAX_BYTES } from '@/lib/desktop/server/pdf-bytes'
import { bindCoworkerPdfFolder } from '@/lib/desktop/server/pdf-read'
import { hashText } from '@/lib/files/editable'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET } from './route'

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
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('serves one owned PDF and refuses other bytes, paths, and coworkers', async () => {
    expect((await GET(request(alice, '?path=docs/deck.pdf', ''), { params: Promise.resolve({ agentId: alice }) })).status).toBe(401)
    const listed = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
    const identity = listed.find(entry => entry.name === 'deck.pdf')?.identity
    const stat = await lstat(join(workspace('engine-alice'), 'docs', 'deck.pdf'), { bigint: true })
    expect(identity).toBe(`${stat.dev}:${stat.ino}`)

    const ok = await preview('docs/deck.pdf', identity)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('application/pdf')
    expect(ok.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''deck.pdf")
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(deck)

    const ranged = await GET(request(alice, '?path=docs/deck.pdf', token, { range: 'bytes=0-3' }), { params: Promise.resolve({ agentId: alice }) })
    expect(ranged.status).toBe(200)
    expect(ranged.headers.get('content-type')).toBe('application/pdf')
    expect(ranged.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(deck)

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
    expect(Buffer.from(await response.arrayBuffer())).toEqual(deck)
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
        expect(Buffer.from(await ok.arrayBuffer())).toEqual(healed)
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
