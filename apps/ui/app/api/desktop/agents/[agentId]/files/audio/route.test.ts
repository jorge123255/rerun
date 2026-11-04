import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DESKTOP_AUDIO_MAX_BYTES } from '@/lib/desktop/server/audio-bytes'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as read } from '../read/route'
import { GET as imageRoute } from '../image/route'
import { GET as list, POST as upload } from '../route'
import { GET } from './route'

function u16(value: number) {
    return Buffer.from([value & 255, (value >> 8) & 255])
}
function u32(value: number) {
    return Buffer.from([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255])
}
function wav(format = 1) {
    const fmt = Buffer.concat([u16(format), u16(1), u32(8000), u32(8000), u16(1), u16(8)])
    const chunks = Buffer.concat([Buffer.from('fmt '), u32(fmt.length), fmt, Buffer.from('data'), u32(2), Buffer.from([0x80, 0x80])])
    return Buffer.concat([Buffer.from('RIFF'), u32(4 + chunks.length), Buffer.from('WAVE'), chunks])
}
function mp3Frame() {
    const frame = Buffer.alloc(417)
    frame.set([0xff, 0xfb, 0x90, 0xc0])
    return frame
}

const tone = wav()
const mp3 = mp3Frame()
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const html = '<!doctype html><script>alert(1)</script>'
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3196'
const token = 'e'.repeat(48)
let root: string
let alice: string
let bob: string
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')

function request(id: string, suffix: string, cookie = token, extra: Record<string, string> = {}) {
    return new Request(`${origin}/api/desktop/agents/${id}/files/audio${suffix}`, {
        headers: { host: '127.0.0.1:3196', origin, cookie: `rerun-desktop-session=${cookie}`, ...extra },
    })
}
const audio = (path: string, identity?: string, id = alice) => {
    const query = new URLSearchParams({ path })
    if (identity !== undefined) query.set('identity', identity)
    return GET(request(id, `?${query}`), { params: Promise.resolve({ agentId: id }) })
}
const listing = (path = 'docs', id = alice) => list(new Request(`${origin}/api/desktop/agents/${id}/files?path=${encodeURIComponent(path)}`, {
    headers: { host: '127.0.0.1:3196', origin, cookie: `rerun-desktop-session=${token}` },
}), { params: Promise.resolve({ agentId: id }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-audio-api-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'audio', buildId: 'audio-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    for (const [id, text] of [['engine-alice', 'Alice bytes'], ['engine-bob', 'Bob bytes']] as const) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
    }
    await writeFile(join(workspace('engine-alice'), 'docs', 'tone.wav'), tone)
    await writeFile(join(workspace('engine-alice'), 'docs', 'tone.mp3'), mp3)
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.png'), png)
    await writeFile(join(workspace('engine-alice'), 'docs', 'page.wav'), html)
    await writeFile(join(workspace('engine-alice'), 'docs', 'page.mp3'), html)
    await writeFile(join(workspace('engine-alice'), 'docs', 'draw.svg'), svg)
    await writeFile(join(workspace('engine-alice'), 'docs', 'adpcm.wav'), wav(2))
    const layer2 = mp3Frame()
    layer2[1] = 0xfd
    await writeFile(join(workspace('engine-alice'), 'docs', 'layer.mp3'), layer2)
    await writeFile(join(workspace('engine-bob'), 'docs', 'tone.mp3'), tone)
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('serves one owned WAV or MP3 and refuses other bytes, paths, and coworkers', async () => {
    expect((await GET(request(alice, '?path=docs/tone.wav', ''), { params: Promise.resolve({ agentId: alice }) })).status).toBe(401)
    const listed = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
    const identity = listed.find(entry => entry.name === 'tone.wav')?.identity
    const stat = await lstat(join(workspace('engine-alice'), 'docs', 'tone.wav'), { bigint: true })
    expect(identity).toBe(`${stat.dev}:${stat.ino}`)

    const ok = await audio('docs/tone.wav', identity)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('audio/wav')
    expect(ok.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''tone.wav")
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(tone)

    const ranged = await GET(request(alice, '?path=docs/tone.mp3', token, { range: 'bytes=0-3' }), { params: Promise.resolve({ agentId: alice }) })
    expect(ranged.status).toBe(200)
    expect(ranged.headers.get('content-type')).toBe('audio/mpeg')
    expect(ranged.headers.get('content-range')).toBeNull()
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(mp3)

    for (const path of ['docs/page.wav', 'docs/page.mp3', 'docs/draw.svg', 'docs/notes.md', 'docs/shot.png']) {
        const refused = await audio(path)
        expect(refused.status, path).toBe(415)
        expect(refused.headers.get('content-type')).toContain('application/json')
        const body = await refused.text()
        expect(body.includes('<svg') || body.includes('<script') || body.includes('Alice bytes') || body.includes('RIFF')).toBe(false)
    }
    expect((await audio('docs/adpcm.wav')).status).toBe(415)
    expect((await (await audio('docs/adpcm.wav')).json()).error).toBe('This audio format can’t be previewed.')
    expect((await (await audio('docs/layer.mp3')).json()).error).toBe('This audio format can’t be previewed.')
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'page.wav'), 'utf8')).toBe(html)

    expect((await audio('../engine-bob/workspace/docs/tone.wav')).status).toBe(400)
    expect((await audio('docs/../../engine-bob/workspace/docs/tone.wav')).status).toBe(400)
    expect((await audio('docs/missing.wav')).status).toBe(404)
    expect((await audio('')).status).toBe(400)
    expect((await audio('docs/tone.wav', 'nope')).status).toBe(400)

    await symlink(join(workspace('engine-alice'), 'docs', 'tone.wav'), join(workspace('engine-alice'), 'docs', 'alias.wav'))
    await symlink(join(workspace('engine-bob'), 'docs', 'tone.mp3'), join(workspace('engine-alice'), 'docs', 'outside.mp3'))
    await symlink(join(workspace('engine-alice'), 'docs'), join(workspace('engine-alice'), 'linkdir'))
    for (const path of ['docs/alias.wav', 'docs/outside.mp3', 'linkdir/tone.wav']) {
        const refused = await audio(path)
        expect(refused.status, path).toBe(400)
        expect(await refused.text()).not.toContain('RIFF')
    }
    expect((await audio('docs/tone.wav', identity)).status).toBe(200)
    expect((await audio('docs/tone.mp3', undefined, bob)).status).toBe(415)
    expect((await audio('docs/tone.wav', undefined, bob)).status).toBe(404)

    await writeFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-tone.wav'), tone)
    expect((await audio('docs/.rerun-edit-tone.wav')).status).toBe(400)
    expect(await readFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-tone.wav'))).toEqual(tone)
})

test('a changed inode is not served, and a damaged or oversized audio file is not returned as bytes', async () => {
    const identity = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries.find(entry => entry.name === 'tone.mp3')?.identity
    const target = join(workspace('engine-alice'), 'docs', 'tone.mp3')
    await rename(target, target + '.hold')
    await writeFile(target, tone)
    const replaced = await audio('docs/tone.mp3', identity)
    expect(replaced.status).toBe(409)
    expect(await replaced.text()).not.toContain('RIFF')
    expect(await readFile(target)).toEqual(tone)
    expect((await audio('docs/tone.mp3')).status).toBe(415)

    await writeFile(join(workspace('engine-alice'), 'docs', 'broken.wav'), tone.subarray(0, tone.length - 1))
    expect((await audio('docs/broken.wav')).status).toBe(415)
    await writeFile(join(workspace('engine-alice'), 'docs', 'huge.mp3'), Buffer.alloc(DESKTOP_AUDIO_MAX_BYTES + 1))
    const huge = await audio('docs/huge.mp3')
    expect(huge.status).toBe(413)
    expect((await huge.json()).error).toBe('Audio files can be up to 16 MB.')
    expect(Number(huge.headers.get('content-length'))).toBeLessThan(200)

    const extra = join(workspace('engine-alice'), 'docs', 'extra.wav')
    await link(join(workspace('engine-alice'), 'docs', 'tone.wav'), extra)
    expect((await audio('docs/tone.wav')).status).toBe(400)
    expect((await audio('docs/extra.wav')).status).toBe(400)
    await unlink(extra)
    expect((await audio('docs/tone.wav')).status).toBe(200)
})

test('text read, image preview, and text import stay on their own contracts', async () => {
    const preview = await read(new Request(`${origin}/api/desktop/agents/${alice}/files/read?path=docs/notes.md`, {
        headers: { host: '127.0.0.1:3196', origin, cookie: `rerun-desktop-session=${token}` },
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ path: 'docs/notes.md', content: 'Alice bytes', truncated: false })

    const image = await imageRoute(new Request(`${origin}/api/desktop/agents/${alice}/files/image?path=docs/shot.png`, {
        headers: { host: '127.0.0.1:3196', origin, cookie: `rerun-desktop-session=${token}` },
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)

    const mp3Form = new FormData()
    mp3Form.set('path', 'docs')
    mp3Form.set('file', new File([mp3], 'incoming.mp3'))
    const imported = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: mp3Form, headers: { host: '127.0.0.1:3196', origin, cookie: `rerun-desktop-session=${token}` },
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(imported.status).toBe(415)
    expect(await readdir(join(workspace('engine-alice'), 'docs'))).not.toContain('incoming.mp3')

    const textForm = new FormData()
    textForm.set('path', 'docs')
    textForm.set('file', new File(['# note'], 'brief.md'))
    const text = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: textForm, headers: { host: '127.0.0.1:3196', origin, cookie: `rerun-desktop-session=${token}` },
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(text.status).toBe(201)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'brief.md'), 'utf8')).toBe('# note')
})
