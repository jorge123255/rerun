import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { GET as readShared } from './read/route'
import { GET, POST } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189'
const token = 's'.repeat(48)
let root: string

function request(path: string, method = 'GET', body?: FormData) {
    return new Request(`${origin}/api/desktop/shared-files${path}`, {
        method,
        headers: { host: new URL(origin).host, origin, cookie: `rerun-desktop-session=${token}` },
        body,
    })
}

function form(name: string, contents: string, folder: string) {
    const body = new FormData()
    body.set('file', new File([contents], name, { type: 'text/plain' }))
    body.set('path', folder)
    body.set('root', '/etc')
    body.set('engineId', 'not-an-engine')
    body.set('scope', 'private')
    return body
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-shared-files-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'shared', buildId: 'shared-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' },
    }), { mode: 0o600 })
    await mkdir(join(root, 'workspaces', '1', 'engine', 'agents', 'alice', 'workspace'), { recursive: true })
    await writeFile(join(root, 'workspaces', '1', 'engine', 'agents', 'alice', 'workspace', 'secret.txt'), 'private-only')
})

afterEach(async () => {
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('two reads return the same create-only import and ignore root, engine, and scope fields', async () => {
    expect((await GET(request('?path='))).status).toBe(200)
    expect(await (await GET(request('?path='))).json()).toMatchObject({ path: '', entries: [], truncated: false })
    const created = await POST(request('', 'POST', form('note.txt', 'from both', 'handoff')))
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ path: 'handoff/note.txt', name: 'note.txt' })
    const again = await POST(request('', 'POST', form('note.txt', 'replaced', 'handoff')))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: expect.stringContaining('existing file was kept') })
    const query = '/read?path=handoff/note.txt&root=%2Fetc&engineId=no&scope=private'
    const first = await (await readShared(request(query))).json()
    const second = await (await readShared(request(query))).json()
    expect(first).toMatchObject({ path: 'handoff/note.txt', content: 'from both', truncated: false })
    expect(second.content).toBe(first.content)
    const listing = await (await GET(request('?path=handoff&root=%2Ftmp'))).json()
    expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(['note.txt'])
})

test('a private file, a symlink, and a hard link are not opened as shared text', async () => {
    const shared = join(root, 'workspaces', '1', 'engine', 'shared')
    const secret = join(root, 'workspaces', '1', 'engine', 'agents', 'alice', 'workspace', 'secret.txt')
    await POST(request('', 'POST', form('note.txt', 'from both', '')))
    await symlink(secret, join(shared, 'linked.txt'))
    await link(secret, join(shared, 'alias.txt'))
    for (const path of ['../agents/alice/workspace/secret.txt', 'linked.txt', 'alias.txt', '/etc/passwd']) {
        const response = await readShared(request(`/read?path=${encodeURIComponent(path)}&root=%2Fetc`))
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(await response.text()).not.toContain('private-only')
    }
    expect(await readFile(secret, 'utf8')).toBe('private-only')
    const names = ((await (await GET(request('?path='))).json()).entries as { name: string }[]).map(entry => entry.name)
    expect(names).toContain('note.txt')
    expect(names).not.toContain('secret.txt')
    expect(names).not.toContain('linked.txt')
})
