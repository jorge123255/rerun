import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { createDesktopAgent } from './store'
import { DesktopHttpError } from './auth'
import { composerTestPng } from './composer-image.test-fixtures'
import { bmp24, ico, iconDib } from './preview-raster-formats/fixtures'
import { SAFE_RED_CIRCLE } from './preview-svg/fixtures'
import { importCoworkerRasterFile, importCoworkerFile } from './coworker-files'
const faults = vi.hoisted(() => ({ afterLink: null as ((target: string) => Promise<void>) | null }))
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, link: async (...args: Parameters<typeof actual.link>) => {
        await actual.link(...args)
        await faults.afterLink?.(String(args[1]))
    } }
})
import {
    importDesktopComposerImage,
    pruneDesktopImageSnapshots,
    readDesktopImageSnapshot,
    readDesktopImageSnapshots,
    DESKTOP_IMAGE_STORE_MAX_BYTES,
} from './composer-image-files'

// A real 1x1 PNG: structural checks and the sharp decode pass both run against it.
const PNG = composerTestPng()
const PNG_2 = composerTestPng(0)
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]
const STATIC_GIF = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)

let root: string
let runtime: DesktopRuntime
let agentId: string
let db: Awaited<ReturnType<typeof openDesktopDatabase>>

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const agentDir = () => join(root, 'workspaces', '1', 'engine', 'agents', 'engine-a')

async function errorOf(promise: Promise<unknown>): Promise<DesktopHttpError> {
    try { await promise } catch (error) {
        if (error instanceof DesktopHttpError) return error
        throw error
    }
    throw new Error('Expected the import to reject')
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-image-'))
    db = await openDesktopDatabase(root)
    const agent = await createDesktopAgent(db, { engineAgentId: 'engine-a', name: 'a' })
    agentId = agent.id
    runtime = {
        protocolVersion: 1, launchNonce: 'nonce', buildId: 'build', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:4100/', sessionToken: 's'.repeat(32) },
        engine: { origin: 'http://127.0.0.1:4101/', apiKey: 'key' },
    }
})

afterEach(async () => {
    faults.afterLink = null
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
})

test('import writes the visible workspace file and a content-addressed snapshot, then reads it back verified', async () => {
    const result = await importDesktopComposerImage(runtime, agentId, '', 'shot.png', PNG)
    expect(result.path).toBe('shot.png')
    expect(result.name).toBe('shot.png')
    expect(result.image).toMatchObject({
        sha256: sha256(PNG), name: 'shot.png', path: 'shot.png',
        mediaType: 'image/png', width: 1, height: 1, byteLength: PNG.byteLength,
    })
    const visible = await readFile(join(agentDir(), 'workspace', 'shot.png'))
    expect(new Uint8Array(visible)).toEqual(PNG)
    const snap = await readDesktopImageSnapshot(runtime, agentId, result.image)
    expect(new Uint8Array(snap.bytes)).toEqual(PNG)
    const batch = await readDesktopImageSnapshots(runtime, agentId, [result.image])
    expect(batch.get(result.image.sha256)).toEqual(PNG)
})

test('the visible import is create-only while identical bytes reuse one snapshot', async () => {
    const first = await importDesktopComposerImage(runtime, agentId, '', 'a.png', PNG)
    const clash = await errorOf(importDesktopComposerImage(runtime, agentId, '', 'a.png', PNG))
    expect(clash.status).toBe(409)
    const second = await importDesktopComposerImage(runtime, agentId, '', 'b.png', PNG)
    expect(second.image.sha256).toBe(first.image.sha256)
    expect(second.path).toBe('b.png')
})

test('unsupported names, non-image bytes, and wrong magic are refused', async () => {
    for (const [name, bytes] of [
        ['doc.txt', PNG], ['still.gif', PNG], ['fake.png', new Uint8Array([1, 2, 3])],
        ['.hidden.png', PNG], ['bad\x07.png', PNG],
    ] as const) {
        const error = await errorOf(importDesktopComposerImage(runtime, agentId, '', name, bytes as Uint8Array))
        expect(error.status, name).toBe(415)
    }
    const wrongMagic = await errorOf(importDesktopComposerImage(runtime, agentId, '', 'photo.png', PNG_2.slice(0, 4)))
    expect(wrongMagic.status).toBe(415)
})

test('static GIF, BMP, ICO and the safe SVG subset publish canonical PNG snapshots with display names', async () => {
    const cases = [
        ['still.gif', STATIC_GIF],
        ['picture.bmp', new Uint8Array(bmp24(2, 2))],
        ['icon.ico', new Uint8Array(ico([{ bytes: iconDib(1, 1), width: 1, height: 1 }]))],
        ['logo.svg', new TextEncoder().encode(SAFE_RED_CIRCLE)],
    ] as const
    for (const [name, source] of cases) {
        const result = await importDesktopComposerImage(runtime, agentId, '', name, source)
        expect(result.name, name).toBe(name)
        expect(result.image.name).toBe(name)
        expect(result.image.mediaType).toBe('image/png')
        expect(result.path).not.toBe(name)
        expect(result.path.endsWith('.png')).toBe(true)
        expect(result.image.path).toBe(result.path)
        const visible = new Uint8Array(await readFile(join(agentDir(), 'workspace', result.path)))
        expect(isPng(visible), name).toBe(true)
        expect(result.image.sha256).toBe(sha256(visible))
        expect(result.image.byteLength).toBe(visible.byteLength)
        const snapshot = await readDesktopImageSnapshot(runtime, agentId, result.image)
        expect(isPng(snapshot.bytes), name).toBe(true)
        expect(new Uint8Array(await readFile(join(agentDir(), 'chat-images', `${result.image.sha256}.png`)))).toEqual(visible)
    }
})

test('folders stay inside the workspace and missing folders are refused', async () => {
    const error = await errorOf(importDesktopComposerImage(runtime, agentId, '../escape', 'x.png', PNG))
    expect(error.status).toBe(400)
    const missing = await errorOf(importDesktopComposerImage(runtime, agentId, 'nope', 'x.png', PNG))
    expect(missing.status).toBe(404)
})

test('a replaced snapshot fails verification instead of silently serving new bytes', async () => {
    const result = await importDesktopComposerImage(runtime, agentId, '', 'shot.png', PNG)
    const snapPath = join(agentDir(), 'chat-images', `${result.image.sha256}.png`)
    await writeFile(snapPath, PNG_2)
    const error = await errorOf(readDesktopImageSnapshot(runtime, agentId, result.image))
    expect(error.status).toBe(409)
})

test('a stale caller keep-set cannot delete a snapshot held by another draft or pending send', async () => {
    const keep = await importDesktopComposerImage(runtime, agentId, '', 'keep.png', PNG)
    const drop = await importDesktopComposerImage(runtime, agentId, '', 'drop.png', PNG_2)
    const removed = await pruneDesktopImageSnapshots(runtime, agentId, new Set([keep.image.sha256]))
    expect(removed).toBe(0)
    await expect(readDesktopImageSnapshot(runtime, agentId, keep.image)).resolves.toMatchObject({ byteLength: PNG.byteLength })
    await expect(readDesktopImageSnapshot(runtime, agentId, drop.image)).resolves.toMatchObject({ byteLength: PNG_2.byteLength })
})

test('same-size snapshot corruption refuses the next import before its visible publication', async () => {
    const first = await importDesktopComposerImage(runtime, agentId, '', 'first.png', PNG)
    const broken = PNG.slice()
    broken[broken.length - 1] = broken[broken.length - 1]! ^ 1
    await writeFile(join(agentDir(), 'chat-images', `${first.image.sha256}.png`), broken)
    expect((await errorOf(importDesktopComposerImage(runtime, agentId, '', 'second.png', PNG))).status).toBe(409)
    await expect(readFile(join(agentDir(), 'workspace', 'second.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(agentDir(), 'workspace'))).filter(name => name.startsWith('.rerun-import-'))).toEqual([])
})

test('snapshot symlinks, hardlinks and parent symlinks stay unreadable', async () => {
    const result = await importDesktopComposerImage(runtime, agentId, '', 'shot.png', PNG)
    const snapshots = join(agentDir(), 'chat-images')
    const target = join(snapshots, `${result.image.sha256}.png`)
    const outside = join(root, 'outside.png')
    await writeFile(outside, PNG)
    await unlink(target)
    await symlink(outside, target)
    expect((await errorOf(readDesktopImageSnapshot(runtime, agentId, result.image))).status).toBe(409)
    await unlink(target)
    await link(outside, target)
    expect((await errorOf(readDesktopImageSnapshot(runtime, agentId, result.image))).status).toBe(409)
    await unlink(target)
    await writeFile(target, PNG)
    await rename(snapshots, `${snapshots}-aside`)
    await symlink(`${snapshots}-aside`, snapshots)
    expect((await errorOf(readDesktopImageSnapshot(runtime, agentId, result.image))).status).toBe(409)
    expect(new Uint8Array(await readFile(outside))).toEqual(PNG)
})

test('snapshot metadata and coworker ownership are checked against actual bytes', async () => {
    const result = await importDesktopComposerImage(runtime, agentId, '', 'shot.png', PNG)
    for (const mismatch of [{ width: 2 }, { height: 2 }, { byteLength: PNG.length + 1 }]) {
        expect((await errorOf(readDesktopImageSnapshot(runtime, agentId, { ...result.image, ...mismatch }))).status).toBe(409)
    }
    const other = await createDesktopAgent(db, { engineAgentId: 'engine-b', name: 'b' })
    expect((await errorOf(readDesktopImageSnapshot(runtime, other.id, result.image))).status).toBe(404)
    expect((await errorOf(readDesktopImageSnapshots(runtime, agentId, Array(5).fill(result.image)))).status).toBe(413)
})

test('bounded storage refuses new bytes before publishing a visible file, without pruning old attachments', async () => {
    const first = await importDesktopComposerImage(runtime, agentId, '', 'first.png', PNG)
    const reserve = join(agentDir(), 'chat-images', 'reserved-capacity')
    await writeFile(reserve, '')
    await truncate(reserve, DESKTOP_IMAGE_STORE_MAX_BYTES)
    expect((await errorOf(importDesktopComposerImage(runtime, agentId, '', 'second.png', PNG_2))).status).toBe(413)
    await expect(readFile(join(agentDir(), 'workspace', 'second.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readDesktopImageSnapshot(runtime, agentId, first.image)).resolves.toMatchObject({ byteLength: PNG.length })
})

test('a moved folder before publication stays unpublished and text import restrictions remain unchanged', async () => {
    await importDesktopComposerImage(runtime, agentId, '', 'first.png', PNG)
    const workspace = join(agentDir(), 'workspace')
    const moved = `${workspace}-aside`
    const error = await errorOf(importCoworkerRasterFile(runtime, agentId, '', 'moved.png', PNG, async () => {
        await rename(workspace, moved)
        await mkdir(workspace)
    }))
    expect(error.status).toBe(409)
    await expect(readFile(join(moved, 'moved.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace, 'moved.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(moved)).filter(name => name.startsWith('.rerun-import-'))).toEqual([])
    expect((await errorOf(importCoworkerFile(runtime, agentId, '', 'text-only.png', PNG))).status).toBe(415)
})

test('cancelled image imports never publish a visible file', async () => {
    const controller = new AbortController()
    controller.abort()
    expect((await errorOf(importDesktopComposerImage(runtime, agentId, '', 'cancelled.png', PNG, { signal: controller.signal }))).status).toBe(499)
    await expect(readFile(join(agentDir(), 'workspace', 'cancelled.png'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a folder move after visible publication is always reported as ambiguous, even when rollback succeeds', async () => {
    await importDesktopComposerImage(runtime, agentId, '', 'first.png', PNG)
    const workspace = join(agentDir(), 'workspace')
    faults.afterLink = async target => {
        if (!target.endsWith('/ambiguous.png')) return
        await rename(workspace, `${workspace}-aside`)
        await mkdir(workspace)
    }
    const error = await errorOf(importDesktopComposerImage(runtime, agentId, '', 'ambiguous.png', PNG))
    expect(error.status).toBe(500)
    await expect(readFile(join(workspace, 'ambiguous.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(`${workspace}-aside`, 'ambiguous.png'))).rejects.toMatchObject({ code: 'ENOENT' })
})
