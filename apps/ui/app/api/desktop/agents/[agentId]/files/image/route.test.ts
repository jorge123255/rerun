import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DESKTOP_IMAGE_MAX_BYTES } from '@/lib/desktop/server/image-bytes'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as read } from '../read/route'
import { GET as list, POST as upload } from '../route'
import { GET } from './route'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af//Z', 'base64')
const widePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAIygAAAABCAAAAACWSFqZAAAAAElFTkSuQmCC', 'base64')
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
const html = '<!doctype html><script>alert(1)</script>'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3194'
const token = 'e'.repeat(48)
let root: string
let alice: string
let bob: string
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')

function request(id: string, suffix: string, cookie = token) {
    return new Request(`${origin}/api/desktop/agents/${id}/files/image${suffix}`, {
        headers: { host: '127.0.0.1:3194', origin, cookie: `rerun-desktop-session=${cookie}` },
    })
}
const image = (path: string, identity?: string, id = alice) => {
    const query = new URLSearchParams({ path })
    if (identity !== undefined) query.set('identity', identity)
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
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
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
