import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { GET as read } from '../read/route'
import { GET as imageRoute } from '../image/route'
import { GET as audioRoute } from '../audio/route'
import { GET as list, POST as upload } from '../route'
import { DESKTOP_VIDEO_MAX_BYTES } from '@/lib/desktop/server/video-bytes'
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
function movie(handler = 'vide') {
    return box('moov', box('trak', box('mdia', hdlr(handler))))
}
function mp4(handler = 'vide', major = 'isom', compatible = ['mp42']) {
    return Buffer.concat([ftyp(major, compatible), movie(handler), box('mdat', Buffer.from([0]))])
}
function wav() {
    const fmt = Buffer.concat([u16(1), u16(1), u32le(8000), u32le(8000), u16(1), u16(8)])
    const chunks = Buffer.concat([Buffer.from('fmt '), u32le(fmt.length), fmt, Buffer.from('data'), u32le(2), Buffer.from([0x80, 0x80])])
    return Buffer.concat([Buffer.from('RIFF'), u32le(4 + chunks.length), Buffer.from('WAVE'), chunks])
}

const clip = mp4()
const tone = wav()
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const html = '<!doctype html><script>alert(1)</script>'
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3197'
const token = 'e'.repeat(48)
let root: string
let alice: string
let bob: string
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')

function request(id: string, suffix: string, cookie = token, extra: Record<string, string> = {}) {
    return new Request(`${origin}/api/desktop/agents/${id}/files/video${suffix}`, {
        headers: { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${cookie}`, ...extra },
    })
}
const video = (path: string, identity?: string, id = alice) => {
    const query = new URLSearchParams({ path })
    if (identity !== undefined) query.set('identity', identity)
    return GET(request(id, `?${query}`), { params: Promise.resolve({ agentId: id }) })
}
const listing = (path = 'docs', id = alice) => list(new Request(`${origin}/api/desktop/agents/${id}/files?path=${encodeURIComponent(path)}`, {
    headers: { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${token}` },
}), { params: Promise.resolve({ agentId: id }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-video-api-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'video', buildId: 'video-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    for (const [id, text] of [['engine-alice', 'Alice bytes'], ['engine-bob', 'Bob bytes']] as const) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
    }
    await writeFile(join(workspace('engine-alice'), 'docs', 'clip.mp4'), clip)
    await writeFile(join(workspace('engine-alice'), 'docs', 'tone.wav'), tone)
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.png'), png)
    await writeFile(join(workspace('engine-alice'), 'docs', 'page.mp4'), html)
    await writeFile(join(workspace('engine-alice'), 'docs', 'draw.mp4'), svg)
    await writeFile(join(workspace('engine-alice'), 'docs', 'notes.mp4'), 'Alice bytes')
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.mp4'), png)
    await writeFile(join(workspace('engine-alice'), 'docs', 'tone.mp4'), tone)
    await writeFile(join(workspace('engine-alice'), 'docs', 'quick.mp4'), mp4('vide', 'qt  ', ['qt  ']))
    await writeFile(join(workspace('engine-alice'), 'docs', 'sound.mp4'), mp4('soun'))
    await writeFile(join(workspace('engine-alice'), 'docs', 'clip.webm'), clip)
    await writeFile(join(workspace('engine-alice'), 'docs', 'clip.mov'), clip)
    await writeFile(join(workspace('engine-bob'), 'docs', 'clip.mp4'), html)
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('serves one owned MP4 and refuses other bytes, paths, and coworkers', async () => {
    expect((await GET(request(alice, '?path=docs/clip.mp4', ''), { params: Promise.resolve({ agentId: alice }) })).status).toBe(401)
    const listed = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
    const identity = listed.find(entry => entry.name === 'clip.mp4')?.identity
    const stat = await lstat(join(workspace('engine-alice'), 'docs', 'clip.mp4'), { bigint: true })
    expect(identity).toBe(`${stat.dev}:${stat.ino}`)

    const ok = await video('docs/clip.mp4', identity)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('video/mp4')
    expect(ok.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''clip.mp4")
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(clip)

    const ranged = await GET(request(alice, '?path=docs/clip.mp4', token, { range: 'bytes=0-3' }), { params: Promise.resolve({ agentId: alice }) })
    expect(ranged.status).toBe(200)
    expect(ranged.headers.get('content-type')).toBe('video/mp4')
    expect(ranged.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(clip)

    for (const path of ['docs/page.mp4', 'docs/draw.mp4', 'docs/notes.mp4', 'docs/shot.mp4', 'docs/tone.mp4']) {
        const refused = await video(path)
        expect(refused.status, path).toBe(415)
        expect(refused.headers.get('content-type')).toContain('application/json')
        const body = await refused.text()
        expect(body.includes('<svg') || body.includes('<script') || body.includes('Alice bytes') || body.includes('RIFF') || body.includes('ftyp')).toBe(false)
    }
    expect((await (await video('docs/quick.mp4')).json()).error).toBe('This video format can’t be previewed.')
    expect((await (await video('docs/sound.mp4')).json()).error).toBe('This video format can’t be previewed.')
    // An MP4 renamed WebM fails its byte signature; MOV supports the ISO movie family.
    expect((await (await video('docs/clip.webm')).json()).error).toBe('This file is not a supported video file.')
    const mov = await video('docs/clip.mov')
    expect(mov.status).toBe(200)
    expect(mov.headers.get('content-type')).toBe('video/quicktime')
    expect(Buffer.from(await mov.arrayBuffer())).toEqual(clip)

    expect((await video('../engine-bob/workspace/docs/clip.mp4')).status).toBe(400)
    expect((await video('docs/../../engine-bob/workspace/docs/clip.mp4')).status).toBe(400)
    expect((await video('docs/missing.mp4')).status).toBe(404)
    expect((await video('')).status).toBe(400)
    expect((await video('docs/clip.mp4', 'nope')).status).toBe(400)

    await symlink(join(workspace('engine-alice'), 'docs', 'clip.mp4'), join(workspace('engine-alice'), 'docs', 'alias.mp4'))
    await symlink(join(workspace('engine-bob'), 'docs', 'clip.mp4'), join(workspace('engine-alice'), 'docs', 'outside.mp4'))
    await symlink(join(workspace('engine-alice'), 'docs'), join(workspace('engine-alice'), 'linkdir'))
    for (const path of ['docs/alias.mp4', 'docs/outside.mp4', 'linkdir/clip.mp4']) {
        const refused = await video(path)
        expect(refused.status, path).toBe(400)
        expect(await refused.text()).not.toContain('ftyp')
    }
    expect((await video('docs/clip.mp4', identity)).status).toBe(200)
    expect((await video('docs/clip.mp4', undefined, bob)).status).toBe(415)
    expect((await video('docs/missing.mp4', undefined, bob)).status).toBe(404)

    await writeFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-clip.mp4'), clip)
    expect((await video('docs/.rerun-edit-clip.mp4')).status).toBe(400)
    expect(await readFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-clip.mp4'))).toEqual(clip)
})

test('a changed inode is not served, and a damaged or oversized video is not returned as bytes', async () => {
    const identity = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries.find(entry => entry.name === 'clip.mp4')?.identity
    const target = join(workspace('engine-alice'), 'docs', 'clip.mp4')
    await rename(target, target + '.hold')
    await writeFile(target, html)
    const replaced = await video('docs/clip.mp4', identity)
    expect(replaced.status).toBe(409)
    expect(await replaced.text()).not.toContain('ftyp')
    expect(await readFile(target, 'utf8')).toBe(html)
    expect((await video('docs/clip.mp4')).status).toBe(415)

    await writeFile(join(workspace('engine-alice'), 'docs', 'broken.mp4'), clip.subarray(0, 30))
    expect((await (await video('docs/broken.mp4')).json()).error).toBe('This video is damaged and can’t be previewed.')
    await writeFile(join(workspace('engine-alice'), 'docs', 'huge.mp4'), Buffer.alloc(DESKTOP_VIDEO_MAX_BYTES + 1))
    const huge = await video('docs/huge.mp4')
    expect(huge.status).toBe(413)
    expect((await huge.json()).error).toBe('Video files can be up to 16 MB.')
    expect(Number(huge.headers.get('content-length'))).toBeLessThan(200)

    const keep = join(workspace('engine-alice'), 'docs', 'keep.mp4')
    await writeFile(keep, clip)
    const extra = join(workspace('engine-alice'), 'docs', 'extra.mp4')
    await link(keep, extra)
    expect((await video('docs/keep.mp4')).status).toBe(400)
    expect((await video('docs/extra.mp4')).status).toBe(400)
    await unlink(extra)
    expect((await video('docs/keep.mp4')).status).toBe(200)
})

test('text read, image preview, audio preview, and text import stay on their own contracts', async () => {
    const headers = { host: '127.0.0.1:3197', origin, cookie: `rerun-desktop-session=${token}` }
    const preview = await read(new Request(`${origin}/api/desktop/agents/${alice}/files/read?path=docs/notes.md`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ path: 'docs/notes.md', content: 'Alice bytes', truncated: false })

    const image = await imageRoute(new Request(`${origin}/api/desktop/agents/${alice}/files/image?path=docs/shot.png`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')

    const audio = await audioRoute(new Request(`${origin}/api/desktop/agents/${alice}/files/audio?path=docs/tone.wav`, { headers }), { params: Promise.resolve({ agentId: alice }) })
    expect(audio.status).toBe(200)
    expect(audio.headers.get('content-type')).toBe('audio/wav')

    const mp4Form = new FormData()
    mp4Form.set('path', 'docs')
    mp4Form.set('file', new File([clip], 'incoming.mp4'))
    const imported = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: mp4Form, headers,
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(imported.status).toBe(415)
    expect(await readdir(join(workspace('engine-alice'), 'docs'))).not.toContain('incoming.mp4')

    const textForm = new FormData()
    textForm.set('path', 'docs')
    textForm.set('file', new File(['# note'], 'brief.md'))
    const text = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: textForm, headers,
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(text.status).toBe(201)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'brief.md'), 'utf8')).toBe('# note')
})
