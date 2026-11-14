import { link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as list } from '../route'
import { GET as download } from './route'

const origin = 'http://127.0.0.1:3190'
const token = 'a'.repeat(64)
const original = Uint8Array.of(0, 127, 255, 10)
let root: string, alice: string, bob: string
const workspace = (engineId: string) => join(root, 'workspaces', '1', 'engine', 'agents', engineId, 'workspace')
const query = (path: string, version: string) => new URLSearchParams({ path, version }).toString()
function request(id: string, suffix: string, authenticated = true) {
    return new Request(`${origin}/api/desktop/agents/${id}/files${suffix}`, {
        headers: { host: '127.0.0.1:3190', ...(authenticated && { cookie: `rerun-desktop-session=${token}` }) },
    })
}
const context = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
const get = (id: string, path: string, version: string) => download(request(id, `/download?${query(path, version)}`), context(id))
async function versionOf(id: string, name = 'report.bin') {
    const response = await list(request(id, '?path=docs'), context(id))
    expect(response.status).toBe(200)
    const { entries } = await response.json()
    const version = entries.find((entry: { name: string }) => entry.name === name)?.exportVersion
    expect(version).toMatch(/^[a-f0-9]{64}$/)
    return version as string
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-coworker-download-'))
    const runtimePath = join(root, 'runtime.json')
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', runtimePath)
    await writeFile(runtimePath, JSON.stringify({ protocolVersion: 1, launchNonce: 'test', buildId: 'test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    for (const id of ['engine-alice', 'engine-bob']) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'report.bin'), original)
    }
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

test('returns original binary bytes and attachment headers for the selected version', async () => {
    const version = await versionOf(alice)
    const response = await get(alice, 'docs/report.bin', version)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''report.bin")
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original)
})

test('refuses a modified file and a version from another coworker', async () => {
    const version = await versionOf(alice)
    expect((await get(bob, 'docs/report.bin', version)).status).toBe(409)
    await writeFile(join(workspace('engine-alice'), 'docs', 'report.bin'), Uint8Array.of(0, 10))
    expect((await get(alice, 'docs/report.bin', version)).status).toBe(409)
    const newVersion = await versionOf(alice)
    expect(newVersion).not.toBe(version)
    const response = await get(alice, 'docs/report.bin', newVersion)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0, 10))
})

test('requires desktop authentication and refuses aliases, private paths and ambiguous requests', async () => {
    const version = await versionOf(alice)
    const owned = workspace('engine-alice')
    await symlink(join(workspace('engine-bob'), 'docs'), join(owned, 'other'))
    await symlink(join(owned, 'docs', 'report.bin'), join(owned, 'alias.bin'))
    await link(join(owned, 'docs', 'report.bin'), join(owned, 'hardlink.bin'))
    for (const path of ['/docs/report.bin', '../docs/report.bin', 'other/report.bin', 'alias.bin', 'hardlink.bin', '.rerun-edit-test/report.bin']) {
        expect((await get(alice, path, version)).status).toBe(400)
    }
    const suffix = `/download?${query('docs/report.bin', version)}`
    expect((await download(request(alice, suffix, false), context(alice))).status).toBe(401)
    expect((await download(request(alice, `${suffix}&path=extra.bin`), context(alice))).status).toBe(400)
})

test('refuses a file over the desktop import limit before reading its contents', async () => {
    await truncate(join(workspace('engine-alice'), 'docs', 'report.bin'), 100 * 1024 * 1024 + 1)
    expect((await get(alice, 'docs/report.bin', await versionOf(alice))).status).toBe(413)
})
