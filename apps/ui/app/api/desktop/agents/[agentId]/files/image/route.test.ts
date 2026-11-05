import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DESKTOP_IMAGE_MAX_BYTES } from '@/lib/desktop/server/image-bytes'
import { DESKTOP_PREVIEW_MAX_FRAMES } from '@/lib/desktop/server/animated-image'
import { bindCoworkerPreviewImageFolder } from '@/lib/desktop/server/preview-image'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as read } from '../read/route'
import { GET as list, POST as upload } from '../route'
import { GET } from './route'
import sharp from 'sharp'
import { bmp24, ico, iconDib } from '@/lib/desktop/server/preview-raster-formats/fixtures'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af//Z', 'base64')
const widePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAIygAAAABCAAAAACWSFqZAAAAAElFTkSuQmCC', 'base64')
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
const html = '<!doctype html><script>alert(1)</script>'

function pngChunk(type: string, payload: Buffer) {
    const content = Buffer.concat([Buffer.from(type, 'ascii'), payload])
    let crc = 0xffffffff
    for (const byte of content) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, content, tail])
}

function webpChunk(type: string, payload: Buffer) {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32LE(payload.length, 4)
    return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function webpFile(...chunks: Buffer[]) {
    const content = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks])
    const header = Buffer.alloc(8)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(content.length, 4)
    return Buffer.concat([header, content])
}

function vp8x(width = 1, height = 1, flags = 0) {
    const header = Buffer.alloc(10)
    header[0] = flags
    header.writeUIntLE(width - 1, 4, 3)
    header.writeUIntLE(height - 1, 7, 3)
    return webpChunk('VP8X', header)
}

function vp8Frame(width: number, height: number) {
    const header = Buffer.alloc(10)
    header.set([0x9d, 0x01, 0x2a], 3)
    header.writeUInt16LE(width, 6)
    header.writeUInt16LE(height, 8)
    return webpChunk('VP8 ', header)
}

const env = { ...process.env }
const origin = 'http://127.0.0.1:3194'
const token = 'e'.repeat(48)
let root: string
let alice: string
let bob: string
let restorePreview = () => {}
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')

function request(id: string, suffix: string, cookie = token) {
    return new Request(`${origin}/api/desktop/agents/${id}/files/image${suffix}`, {
        headers: { host: '127.0.0.1:3194', origin, cookie: `rerun-desktop-session=${cookie}` },
    })
}
const image = (path: string, identity?: string, id = alice, animation = false) => {
    const query = new URLSearchParams({ path })
    if (identity !== undefined) query.set('identity', identity)
    if (animation) query.set('animation', '1')
    return GET(request(id, `?${query}`), { params: Promise.resolve({ agentId: id }) })
}
const listing = (path = 'docs', id = alice) => list(new Request(`${origin}/api/desktop/agents/${id}/files?path=${encodeURIComponent(path)}`, {
    headers: { host: '127.0.0.1:3194', origin, cookie: `rerun-desktop-session=${token}` },
}), { params: Promise.resolve({ agentId: id }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-image-api-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'image', buildId: 'image-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    for (const [id, text] of [['engine-alice', 'Alice bytes'], ['engine-bob', 'Bob bytes']] as const) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
    }
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.png'), png)
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.gif'), gif)
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.jpg'), jpeg)
    await writeFile(join(workspace('engine-alice'), 'docs', 'shot.webp'), webp)
    await writeFile(join(workspace('engine-alice'), 'docs', 'page.html'), html)
    await writeFile(join(workspace('engine-alice'), 'docs', 'draw.svg'), svg)
    await writeFile(join(workspace('engine-alice'), 'docs', 'fake.png'), svg)
    await writeFile(join(workspace('engine-bob'), 'docs', 'shot.png'), gif)
    restorePreview = bindCoworkerPreviewImageFolder({
        recoverInterruptedEdits: async () => {},
        claimed: () => false,
    })
})

afterEach(async () => {
    restorePreview()
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('confined Files previews convert SVG AVIF ICO and BMP to inert PNG without changing the source', async () => {
    const safeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>')
    const avif = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).avif({ lossless: true }).toBuffer()
    for (const [name, bytes] of [['safe.svg', safeSvg], ['safe.avif', avif], ['safe.bmp', bmp24()], ['safe.ico', ico([{ bytes: iconDib(), width: 1, height: 1 }])]] as const) {
        const path = join(workspace('engine-alice'), 'docs', name)
        await writeFile(path, bytes)
        const result = await image(`docs/${name}`, undefined, alice, true)
        expect(result.status, name).toBe(200)
        expect(result.headers.get('content-type')).toBe('image/png')
        expect(result.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
        expect((await sharp(Buffer.from(await result.arrayBuffer())).metadata()).format).toBe('png')
        expect(await readFile(path)).toEqual(bytes)
        await link(path, `${path}.linked`)
        expect((await image(`docs/${name}`, undefined, alice, true)).status).toBe(400)
    }
})

test('serves one owned raster and refuses the other formats, paths, and coworkers', async () => {
    expect((await GET(request(alice, '?path=docs/shot.png', ''), { params: Promise.resolve({ agentId: alice }) })).status).toBe(401)
    const listed = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
    const identity = listed.find(entry => entry.name === 'shot.png')?.identity
    const stat = await lstat(join(workspace('engine-alice'), 'docs', 'shot.png'), { bigint: true })
    expect(identity).toBe(`${stat.dev}:${stat.ino}`)

    const ok = await image('docs/shot.png', identity)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.png")
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(png)

    expect((await image('docs/shot.gif')).headers.get('content-type')).toBe('image/gif')
    expect((await image('docs/shot.jpg')).headers.get('content-type')).toBe('image/jpeg')
    expect((await image('docs/shot.webp')).headers.get('content-type')).toBe('image/webp')

    for (const path of ['docs/page.html', 'docs/draw.svg', 'docs/fake.png', 'docs/notes.md']) {
        const refused = await image(path)
        expect(refused.status, path).toBe(415)
        expect(refused.headers.get('content-type')).toContain('application/json')
        const body = await refused.text()
        expect(body.includes('<svg') || body.includes('<script') || body.includes('Alice bytes')).toBe(false)
    }
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'draw.svg'), 'utf8')).toBe(svg)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'page.html'), 'utf8')).toBe(html)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('Alice bytes')

    expect((await image('../engine-bob/workspace/docs/shot.png')).status).toBe(400)
    expect((await image('docs/../../engine-bob/workspace/docs/shot.png')).status).toBe(400)
    expect((await image('docs/missing.png')).status).toBe(404)
    expect((await image('')).status).toBe(400)
    expect((await image('docs/shot.png', 'nope')).status).toBe(400)

    await symlink(join(workspace('engine-alice'), 'docs', 'shot.png'), join(workspace('engine-alice'), 'docs', 'alias.png'))
    await symlink(join(workspace('engine-bob'), 'docs', 'shot.png'), join(workspace('engine-alice'), 'docs', 'outside.png'))
    await symlink(join(workspace('engine-alice'), 'docs'), join(workspace('engine-alice'), 'linkdir'))
    for (const path of ['docs/alias.png', 'docs/outside.png', 'linkdir/shot.png']) {
        const refused = await image(path)
        expect(refused.status, path).toBe(400)
        expect(refused.headers.get('content-type')).toContain('application/json')
        expect(await refused.text()).not.toContain('PNG')
    }
    expect((await image('docs/shot.png', identity)).status).toBe(200)
    expect((await image('docs/shot.png', undefined, bob)).status).toBe(415)
    expect((await image('docs/shot.gif', undefined, bob)).status).toBe(404)

    await writeFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-shot.png'), png)
    expect((await image('docs/.rerun-edit-shot.png')).status).toBe(400)
    expect(await readFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-shot.png'))).toEqual(png)
})

test('a changed inode is not served, and a damaged or oversized image is not returned as bytes', async () => {
    const identity = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries.find(entry => entry.name === 'shot.png')?.identity
    const target = join(workspace('engine-alice'), 'docs', 'shot.png')
    await rename(target, target + '.hold')
    await writeFile(target, gif)
    const replaced = await image('docs/shot.png', identity)
    expect(replaced.status).toBe(409)
    expect(replaced.headers.get('content-type')).toContain('application/json')
    expect(await replaced.text()).not.toContain('GIF89a')
    expect(await readFile(target)).toEqual(gif)
    expect(await readFile(target + '.hold')).toEqual(png)
    expect((await image('docs/shot.png')).status).toBe(415)

    const broken = Buffer.from(png)
    broken[broken.length - 1] ^= 0xff
    await writeFile(join(workspace('engine-alice'), 'docs', 'broken.png'), broken)
    expect((await image('docs/broken.png')).status).toBe(415)
    await writeFile(join(workspace('engine-alice'), 'docs', 'wide.png'), widePng)
    expect((await image('docs/wide.png')).status).toBe(413)
    await writeFile(join(workspace('engine-alice'), 'docs', 'huge.png'), Buffer.alloc(DESKTOP_IMAGE_MAX_BYTES + 1))
    const huge = await image('docs/huge.png')
    expect(huge.status).toBe(413)
    expect((await huge.json()).error).toBe('Images can be up to 8 MB.')
    expect(Number(huge.headers.get('content-length'))).toBeLessThan(200)

    const extra = join(workspace('engine-alice'), 'docs', 'extra.png')
    await link(join(workspace('engine-alice'), 'docs', 'shot.gif'), extra)
    expect((await image('docs/shot.gif')).status).toBe(400)
    expect((await image('docs/extra.png')).status).toBe(400)
    await unlink(extra)
    expect((await image('docs/shot.gif')).status).toBe(200)
    expect(await readdir(join(workspace('engine-alice'), 'docs'))).toContain('shot.gif')
})

test('text read and text import stay on their own contracts', async () => {
    const preview = await read(new Request(`${origin}/api/desktop/agents/${alice}/files/read?path=docs/notes.md`, {
        headers: { host: '127.0.0.1:3194', origin, cookie: `rerun-desktop-session=${token}` },
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ path: 'docs/notes.md', content: 'Alice bytes', truncated: false })

    const pngForm = new FormData()
    pngForm.set('path', 'docs')
    pngForm.set('file', new File([png], 'incoming.png'))
    const imported = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: pngForm, headers: { host: '127.0.0.1:3194', origin, cookie: `rerun-desktop-session=${token}` },
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(imported.status).toBe(415)
    expect(await readdir(join(workspace('engine-alice'), 'docs'))).not.toContain('incoming.png')

    const textForm = new FormData()
    textForm.set('path', 'docs')
    textForm.set('file', new File(['# note'], 'brief.md'))
    const text = await upload(new Request(`${origin}/api/desktop/agents/${alice}/files`, {
        method: 'POST', body: textForm, headers: { host: '127.0.0.1:3194', origin, cookie: `rerun-desktop-session=${token}` },
    }), { params: Promise.resolve({ agentId: alice }) })
    expect(text.status).toBe(201)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'brief.md'), 'utf8')).toBe('# note')
})

test('GIF validates the single frame against the canvas and rejects further frames before browser decoding', async () => {
    const descriptor = gif.indexOf(0x2c, 19)
    expect(descriptor).toBeGreaterThan(18)
    const oversized = Buffer.from(gif)
    oversized.writeUInt16LE(8193, descriptor + 5)
    const outside = Buffer.from(gif)
    outside.writeUInt16LE(1, descriptor + 1)
    const animated = Buffer.concat([gif.subarray(0, gif.length - 1), gif.subarray(descriptor)])
    for (const [name, bytes, status] of [
        ['large-frame.gif', oversized, 413], ['outside-canvas.gif', outside, 415], ['animated.gif', animated, 415],
    ] as const) {
        await writeFile(join(workspace('engine-alice'), 'docs', name), bytes)
        const response = await image(`docs/${name}`)
        expect(response.status, name).toBe(status)
        expect(response.headers.get('content-type')).toContain('application/json')
    }
    expect((await (await image('docs/animated.gif')).json()).error).toContain('Animated')
    expect((await image('docs/shot.gif')).status).toBe(200)
})

test('WebP bounds inner VP8 and VP8L dimensions and requires a single static frame matching VP8X', async () => {
    const losslessHeader = Buffer.alloc(5)
    losslessHeader[0] = 0x2f
    losslessHeader.writeUInt32LE(8192, 1) // Encodes an 8193-pixel frame behind a one-pixel canvas.
    const cases = [
        ['large-inner.webp', webpFile(vp8x(), vp8Frame(8193, 1)), 413],
        ['large-lossless.webp', webpFile(vp8x(), webpChunk('VP8L', losslessHeader)), 413],
        ['mismatched-canvas.webp', webpFile(vp8x(), vp8Frame(2, 1)), 415],
        ['two-images.webp', webpFile(vp8x(), vp8Frame(1, 1), vp8Frame(1, 1)), 415],
    ] as const
    for (const [name, bytes, status] of cases) {
        await writeFile(join(workspace('engine-alice'), 'docs', name), bytes)
        const response = await image(`docs/${name}`)
        expect(response.status, name).toBe(status)
        expect(response.headers.get('content-type')).toContain('application/json')
    }
    // A valid extended static container still uses the original image payload unchanged.
    await writeFile(join(workspace('engine-alice'), 'docs', 'extended.webp'), webpFile(vp8x(), webp.subarray(12)))
    expect((await image('docs/extended.webp')).status).toBe(200)
})

test('APNG control and frame chunks are refused instead of using only the PNG canvas as the decode budget', async () => {
    for (const type of ['acTL', 'fcTL', 'fdAT']) {
        const payload = Buffer.alloc(type === 'acTL' ? 8 : type === 'fcTL' ? 26 : 4)
        if (type === 'acTL') payload.writeUInt32BE(2)
        const bytes = Buffer.concat([png.subarray(0, 33), pngChunk(type, payload), png.subarray(33)])
        await writeFile(join(workspace('engine-alice'), 'docs', `${type}.png`), bytes)
        const response = await image(`docs/${type}.png`)
        expect(response.status, type).toBe(415)
        expect((await response.json()).error).toContain('Animated')
    }
    expect((await image('docs/shot.png')).status).toBe(200)
})

test('WebP animation flags and animation chunks, including an empty ANMF, are never served as static image bytes', async () => {
    const cases = [
        ['animation-flag.webp', webpFile(vp8x(1, 1, 0x02), webp.subarray(12))],
        ['animation-chunk.webp', webpFile(vp8x(), webpChunk('ANIM', Buffer.alloc(6)), webp.subarray(12))],
        ['empty-frame.webp', webpFile(vp8x(), webpChunk('ANMF', Buffer.alloc(0)))],
    ] as const
    for (const [name, bytes] of cases) {
        await writeFile(join(workspace('engine-alice'), 'docs', name), bytes)
        const response = await image(`docs/${name}`)
        expect(response.status, name).toBe(415)
        expect((await response.json()).error).toContain('Animated')
    }
})

function anmf(imageChunk: Buffer, width: number, height: number) {
    const header = Buffer.alloc(16)
    header.writeUIntLE(width - 1, 6, 3)
    header.writeUIntLE(height - 1, 9, 3)
    header.writeUIntLE(100, 12, 3)
    return webpChunk('ANMF', Buffer.concat([header, imageChunk]))
}

test('Files animation preview keeps the original GIF and WebP bytes, including every frame', async () => {
    const descriptor = gif.indexOf(0x2c)
    const animatedGif = Buffer.concat([gif.subarray(0, gif.length - 1), gif.subarray(descriptor)])
    const frame = vp8Frame(1, 1)
    const animatedWebp = webpFile(vp8x(1, 1, 0x02), webpChunk('ANIM', Buffer.alloc(6)), anmf(frame, 1, 1), anmf(frame, 1, 1))
    await writeFile(join(workspace('engine-alice'), 'docs', 'loop.gif'), animatedGif)
    await writeFile(join(workspace('engine-alice'), 'docs', 'loop.webp'), animatedWebp)

    const gifResponse = await image('docs/loop.gif', undefined, alice, true)
    expect(gifResponse.status).toBe(200)
    expect(gifResponse.headers.get('content-type')).toBe('image/gif')
    const gifBytes = Buffer.from(await gifResponse.arrayBuffer())
    expect(gifBytes).toEqual(animatedGif)
    expect(gifBytes.filter(byte => byte === 0x2c)).toHaveLength(2)

    const webpResponse = await image('docs/loop.webp', undefined, alice, true)
    expect(webpResponse.status).toBe(200)
    expect(webpResponse.headers.get('content-type')).toBe('image/webp')
    const webpBytes = Buffer.from(await webpResponse.arrayBuffer())
    expect(webpBytes).toEqual(animatedWebp)
    expect(webpBytes.toString('latin1').split('ANMF')).toHaveLength(3)

    for (const [path, type, bytes] of [
        ['docs/shot.png', 'image/png', png],
        ['docs/shot.jpg', 'image/jpeg', jpeg],
        ['docs/shot.gif', 'image/gif', gif],
        ['docs/shot.webp', 'image/webp', webp],
    ] as const) {
        const still = await image(path, undefined, alice, true)
        expect(still.status, path).toBe(200)
        expect(still.headers.get('content-type'), path).toBe(type)
        expect(Buffer.from(await still.arrayBuffer())).toEqual(bytes)
    }

    const hidden = await image('docs/loop.gif')
    expect(hidden.status).toBe(415)
    expect((await hidden.json()).error).toContain('Animated')
    expect((await image('docs/loop.gif', undefined, alice, true)).status).toBe(200)
})

test('an animated preview still refuses symlinks, hard links, the wrong file, and a flattened animation container', async () => {
    await symlink(join(workspace('engine-alice'), 'docs', 'shot.gif'), join(workspace('engine-alice'), 'docs', 'alias.gif'))
    const linkResponse = await image('docs/alias.gif', undefined, alice, true)
    expect(linkResponse.status).toBe(400)
    expect(await linkResponse.text()).not.toContain('GIF89a')

    const extra = join(workspace('engine-alice'), 'docs', 'extra.gif')
    await link(join(workspace('engine-alice'), 'docs', 'shot.gif'), extra)
    expect((await image('docs/shot.gif', undefined, alice, true)).status).toBe(400)
    await unlink(extra)

    const listed = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
    const identity = listed.find(entry => entry.name === 'shot.png')?.identity
    const target = join(workspace('engine-alice'), 'docs', 'shot.png')
    await rename(target, `${target}.hold`)
    await writeFile(target, gif)
    const replaced = await image('docs/shot.png', identity, alice, true)
    expect(replaced.status).toBe(409)
    expect(await replaced.text()).not.toContain('GIF89a')
    await rename(`${target}.hold`, target)

    const flagged = webpFile(vp8x(1, 1, 0x02), webp.subarray(12))
    await writeFile(join(workspace('engine-alice'), 'docs', 'flagged.webp'), flagged)
    const refused = await image('docs/flagged.webp', undefined, alice, true)
    expect(refused.status).toBe(415)
    expect(refused.headers.get('content-type')).toContain('application/json')
    expect(await refused.text()).not.toContain('RIFF')

    const apng = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', Buffer.alloc(8)), png.subarray(33)])
    await writeFile(join(workspace('engine-alice'), 'docs', 'motion.png'), apng)
    expect((await (await image('docs/motion.png', undefined, alice, true)).json()).error).toBe('Animated PNG can’t be previewed.')

    const descriptor = gif.indexOf(0x2c)
    const one = gif.subarray(descriptor, gif.length - 1)
    const tooMany = Buffer.concat([gif.subarray(0, descriptor), ...Array.from({ length: DESKTOP_PREVIEW_MAX_FRAMES + 1 }, () => one), Buffer.from([0x3b])])
    await writeFile(join(workspace('engine-alice'), 'docs', 'many.gif'), tooMany)
    const many = await image('docs/many.gif', undefined, alice, true)
    expect(many.status).toBe(413)
    expect((await many.json()).error).toBe('This animation has too many frames to preview.')
    expect(Number(many.headers.get('content-length'))).toBeLessThan(200)

    expect((await image('docs/../../engine-bob/workspace/docs/shot.png', undefined, alice, true)).status).toBe(400)
    expect((await GET(request(alice, '?path=docs/shot.png&animation=1&animation=1'), { params: Promise.resolve({ agentId: alice }) })).status).toBe(400)
    expect((await GET(request(alice, '?path=docs/shot.png&animation=0'), { params: Promise.resolve({ agentId: alice }) })).status).toBe(400)
})
