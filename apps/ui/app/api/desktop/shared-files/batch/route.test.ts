import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { prepareSkillHelperFixture } from '../../../../../../engine/src/desktop/skill-publication.test-support'

vi.mock('server-only', () => ({}))
import { POST } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189'
const token = 's'.repeat(48)
let root: string
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>

beforeAll(async () => { helper = await prepareSkillHelperFixture() })
afterAll(async () => { await helper?.close() })
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-shared-batch-route-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json'), RERUN_DESKTOP_RENAME_HELPER: helper.path })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'shared', buildId: 'shared-test', workspaceId: 1, dataRoot: root, app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }), { mode: 0o600 })
    await mkdir(join(root, 'workspaces', '1', 'engine', 'shared'), { recursive: true })
})
afterEach(async () => { process.env = { ...env }; await rm(root, { recursive: true, force: true }) })

function form(entries: { name: string; body?: Uint8Array }[]) {
    const body = new FormData()
    for (const entry of entries) {
        body.append('file', new File([entry.body ?? Buffer.from('body')], entry.name))
    }
    body.set('path', 'nested')
    return new Request(`${origin}/api/desktop/shared-files/batch`, { method: 'POST', headers: { host: new URL(origin).host, origin, cookie: `rerun-desktop-session=${token}` }, body })
}

test('admits a mixed batch with per-file outcomes and no overwrite', async () => {
    await mkdir(join(root, 'workspaces', '1', 'engine', 'shared', 'nested'), { recursive: true })
    await writeFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'existing.txt'), 'original')
    const response = await POST(form([{ name: 'note.md', body: Buffer.from('# shared') }, { name: 'image.png', body: Buffer.from([0, 255, 1]) }, { name: 'existing.txt', body: Buffer.from('changed') }, { name: 'run.exe' }]))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.results).toEqual([
        { name: 'note.md', folder: 'nested', status: 'created', path: 'nested/note.md' },
        { name: 'image.png', folder: 'nested', status: 'created', path: 'nested/image.png' },
        { name: 'existing.txt', folder: 'nested', status: 'refused', message: expect.stringContaining('existing file was kept') },
        { name: 'run.exe', folder: 'nested', status: 'refused', message: expect.stringContaining('supported shared file') },
    ])
    expect(await readFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'image.png'))).toEqual(Buffer.from([0, 255, 1]))
    expect(await readFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'existing.txt'))).toBe('original')
})

test('enforces text and image caps while admitting an ordinary PDF', async () => {
    const response = await POST(form([
        { name: 'large.md', body: Buffer.alloc(1024 * 1024 + 1) },
        { name: 'large.png', body: Buffer.alloc(8 * 1024 * 1024 + 1) },
        { name: 'document.pdf', body: Buffer.from([37, 80, 68, 70]) },
    ]))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.results.map((result: { status: string }) => result.status)).toEqual(['refused', 'refused', 'created'])
    expect(await readFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'document.pdf'))).toEqual(Buffer.from([37, 80, 68, 70]))
})

test('rejects more than 16 files before any file write', async () => {
    const response = await POST(form(Array.from({ length: 17 }, (_, index) => ({ name: `file-${index}.txt` }))))
    expect(response.status).toBe(413)
    await expect(readFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'file-0.txt'))).rejects.toThrow()
})

test('rejects an oversized aggregate batch before any file write', async () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({ name: `file-${index}.pdf`, body: Buffer.alloc(2 * 1024 * 1024 + 1) }))
    const response = await POST(form(entries))
    expect(response.status).toBe(413)
    await expect(readFile(join(root, 'workspaces', '1', 'engine', 'shared', 'nested', 'file-0.pdf'))).rejects.toThrow()
})
