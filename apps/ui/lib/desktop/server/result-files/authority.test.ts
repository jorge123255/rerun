import { mkdtemp, mkdir, writeFile, stat, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { localResultFileAuthority } from './authority'
import { previewResultBytes } from './preview'
import { openDesktopDatabase, closeDesktopDatabase } from '../database'
import { createDesktopAgent } from '../store'
import type { DesktopRuntime } from '../runtime'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) } })
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-result-authority-')); roots.push(root)
    const db = await openDesktopDatabase(root)
    const owner = await createDesktopAgent(db, { name: 'Owner', engineAgentId: 'owner' })
    const folder = join(root, 'workspaces/1/engine/shared'); await mkdir(folder, { recursive: true })
    const path = join(folder, "Bob's report;final.zip"); await writeFile(path, 'safe')
    const info = await stat(path, { bigint: true })
    const input = { runtime: { dataRoot: root } as DesktopRuntime, agentId: owner.id, engineAgentId: 'owner', path: "Bob's report;final.zip", scope: 'shared' as const,
        identity: `${info.dev}:${info.ino}`, size: 4, signal: new AbortController().signal }
    return { root, db, owner, folder, path, input }
}
test('the concrete reader preserves names and refuses changed identities, foreign owners, links and traversal', async () => {
    const f = await fixture()
    expect(new TextDecoder().decode((await localResultFileAuthority.read(f.input))!.bytes)).toBe('safe')
    await expect(localResultFileAuthority.read({ ...f.input, identity: '0:0' })).rejects.toMatchObject({ status: 409 })
    await expect(localResultFileAuthority.read({ ...f.input, engineAgentId: 'other' })).rejects.toMatchObject({ status: 404 })
    await expect(localResultFileAuthority.read({ ...f.input, path: '../outside.zip' })).rejects.toMatchObject({ status: 400 })
    await symlink(f.path, join(f.folder, 'linked.zip'))
    await expect(localResultFileAuthority.read({ ...f.input, path: 'linked.zip' })).rejects.toThrow()
    await link(f.path, join(f.folder, 'hard.zip'))
    await expect(localResultFileAuthority.read(f.input)).rejects.toMatchObject({ status: 409 })
})
test('scope never falls back to another root and cancellation returns no bytes', async () => {
    const f = await fixture()
    await expect(localResultFileAuthority.read({ ...f.input, scope: 'agent' })).rejects.toThrow()
    await expect(localResultFileAuthority.read({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow()
})
test('shared previews validate actual formats and dimensions rather than extensions', async () => {
    const signal = new AbortController().signal
    for (const name of ['broken.png', 'broken.mp4', 'broken.wav', 'broken.pdf']) {
        await expect(previewResultBytes(name, new TextEncoder().encode('not media'), { signal })).rejects.toMatchObject({ status: 415 })
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const result = await previewResultBytes('one.png', png, { signal })
    expect(result.headers.get('content-type')).toBe('image/png')
    expect(result.headers.get('x-image-width')).toBe('1')
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(png))
    await expect(previewResultBytes('unsafe.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { signal })).rejects.toMatchObject({ status: 415 })
})
