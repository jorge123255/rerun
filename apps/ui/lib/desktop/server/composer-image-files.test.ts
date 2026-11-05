import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { createDesktopAgent } from './store'
import { DesktopHttpError } from './auth'
import {
    importDesktopComposerImage,
    pruneDesktopImageSnapshots,
    readDesktopImageSnapshot,
    readDesktopImageSnapshots,
} from './composer-image-files'

// A real 1x1 PNG: structural checks and the sharp decode pass both run against it.
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const PNG_2 = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

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

test('unsupported names, non-image bytes, wrong magic, and GIF stay refused', async () => {
    for (const [name, bytes] of [
        ['doc.txt', PNG], ['anim.gif', PNG], ['fake.png', new Uint8Array([1, 2, 3])],
        ['.hidden.png', PNG], ['bad\x07.png', PNG],
    ] as const) {
        const error = await errorOf(importDesktopComposerImage(runtime, agentId, '', name, bytes as Uint8Array))
        expect(error.status, name).toBe(415)
    }
    const wrongMagic = await errorOf(importDesktopComposerImage(runtime, agentId, '', 'photo.png', PNG_2.slice(0, 4)))
    expect(wrongMagic.status).toBe(415)
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

test('prune removes only unreferenced snapshots', async () => {
    const keep = await importDesktopComposerImage(runtime, agentId, '', 'keep.png', PNG)
    const drop = await importDesktopComposerImage(runtime, agentId, '', 'drop.png', PNG_2)
    const removed = await pruneDesktopImageSnapshots(runtime, agentId, new Set([keep.image.sha256]))
    expect(removed).toBe(1)
    await expect(readDesktopImageSnapshot(runtime, agentId, keep.image)).resolves.toMatchObject({ byteLength: PNG.byteLength })
    const error = await errorOf(readDesktopImageSnapshot(runtime, agentId, drop.image))
    expect(error.status).toBe(404)
})
