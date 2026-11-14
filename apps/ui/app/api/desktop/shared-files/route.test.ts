import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { prepareSkillHelperFixture } from '../../../../../engine/src/desktop/skill-publication.test-support'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'

vi.mock('server-only', () => ({}))

import { GET as readShared } from './read/route'
import { DELETE, GET, PATCH, POST, PUT } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189'
const token = 's'.repeat(48)
let root: string
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>

beforeAll(async () => { helper = await prepareSkillHelperFixture() })
afterAll(async () => { await helper?.close() })

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
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json'), RERUN_DESKTOP_RENAME_HELPER: helper.path })
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

test.skipIf(process.platform !== 'darwin')('replaces a current preview through the authenticated workspace and refuses stale or foreign writes', async () => {
    const path = 'note.md'
    expect((await POST(request('', 'POST', form(path, 'original\r\n', '')))).status).toBe(201)
    const query = '/read?path=note.md'
    const original = await (await readShared(request(query))).json()
    const input = { workspaceId: 1, path, content: 'saved\r\n', base: original.editIdentity }
    const replace = (body: typeof input, headers = request('').headers) => PUT(new Request(request('').url, {
        method: 'PUT', headers, body: JSON.stringify(body),
    }))
    const unauthenticated = request('').headers
    unauthenticated.delete('cookie')
    expect((await replace(input, unauthenticated)).status).toBe(401)
    const foreignOrigin = request('').headers
    foreignOrigin.set('origin', 'http://127.0.0.1:8080')
    expect((await replace(input, foreignOrigin)).status).toBe(403)
    expect((await replace({ ...input, workspaceId: 2 })).status).toBe(409)
    expect((await replace({ ...input, path: '../agents/alice/workspace/secret.txt' })).status).toBe(400)
    const injectedRoot = { ...input, root: root }
    expect((await replace(injectedRoot)).status).toBe(400)
    const runtime = await readDesktopRuntime()
    setDesktopWorkspaceFrozen(runtime, true)
    try { expect((await replace(input)).status).toBe(409) }
    finally { setDesktopWorkspaceFrozen(runtime, false) }
    expect(await (await readShared(request(query))).json()).toMatchObject({ content: 'original\r\n' })

    const response = await replace(input)
    expect(response.status).toBe(200)
    const saved = await response.json()
    expect(saved).toMatchObject({ ok: true, workspaceId: 1, path, recoveryPath: expect.stringMatching(/^shared-edit-recovery-/) })
    const stale = await replace({ ...input, content: 'stale draft' })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: expect.stringContaining('changed') })
    expect(await (await readShared(request(query))).json()).toMatchObject({ content: 'saved\r\n', editIdentity: saved.editIdentity })
    const recovery = await readShared(request(`/read?path=${encodeURIComponent(saved.recoveryPath)}`))
    expect(await recovery.json()).toMatchObject({ content: 'original\r\n', editIdentity: original.editIdentity })
})

test('rejects an oversized multipart stream before parsing, even without Content-Length', async () => {
    const cancelled = vi.fn()
    const sample = request('', 'POST', form('large.txt', 'x', ''))
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
        cancel: cancelled,
    })
    const oversized = new Request(sample.url, { method: 'POST', headers: sample.headers, body: stream, duplex: 'half' } as RequestInit)
    const response = await POST(oversized)
    expect(response.status).toBe(413)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(await (await GET(request('?path='))).json()).toMatchObject({ entries: [] })
})

const deleteRevision = async (folder: string, name: string): Promise<string> => {
    const { entries } = await (await GET(request('?path=' + encodeURIComponent(folder)))).json() as { entries: { name: string; deleteRevision?: string }[] }
    const revision = entries.find(entry => entry.name === name)?.deleteRevision
    expect(revision).toMatch(/^[a-f0-9]{64}$/)
    return revision!
}
const deleteShared = (path: string, revision: string, workspaceId = 1, headers = request('').headers) =>
    DELETE(new Request(request('').url, { method: 'DELETE', headers, body: JSON.stringify({ workspaceId, path, revision }) }))

test('renames a listed folder in the active workspace and preserves the old file-only request', async () => {
    expect((await POST(request('', 'POST', form('report.txt', 'folder bytes', 'handoff/nested')))).status).toBe(201)
    const input = { workspaceId: 1, path: 'handoff', name: 'archive', revision: await deleteRevision('', 'handoff') }
    const renameEntry = (body: object, headers = request('').headers) => PATCH(new Request(request('').url, {
        method: 'PATCH', headers, body: JSON.stringify(body),
    }))
    const anonymous = request('').headers
    anonymous.delete('cookie')
    expect((await renameEntry(input, anonymous)).status).toBe(401)
    expect((await renameEntry({ ...input, workspaceId: 2 })).status).toBe(409)
    expect((await renameEntry({ ...input, revision: 'f'.repeat(64) })).status).toBe(409)
    expect((await renameEntry({ path: input.path, name: input.name })).status).toBe(400)
    const runtime = await readDesktopRuntime()
    setDesktopWorkspaceFrozen(runtime, true)
    try { expect((await renameEntry(input)).status).toBe(409) }
    finally { setDesktopWorkspaceFrozen(runtime, false) }
    const response = await renameEntry(input)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ workspaceId: 1, path: 'archive', name: 'archive' })
    expect(await (await readShared(request('/read?path=archive/nested/report.txt'))).json()).toMatchObject({ content: 'folder bytes' })
    const legacy = await renameEntry({ path: 'archive/nested/report.txt', name: 'receipt.txt' })
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toEqual({ path: 'archive/nested/receipt.txt', name: 'receipt.txt' })
})

test('deletes the exact preview and a listed folder under active workspace authority', async () => {
    expect((await POST(request('', 'POST', form('note.txt', 'old', 'handoff')))).status).toBe(201)
    expect((await POST(request('', 'POST', form('keep.txt', 'keep', '')))).status).toBe(201)
    const revision = await deleteRevision('handoff', 'note.txt')
    expect(await (await readShared(request('/read?path=handoff/note.txt'))).json()).toMatchObject({ deleteRevision: revision })
    const unauthorized = request('').headers
    unauthorized.delete('cookie')
    expect((await deleteShared('handoff/note.txt', revision, 1, unauthorized)).status).toBe(401)
    expect((await deleteShared('handoff/note.txt', revision, 2)).status).toBe(409)
    const runtime = await readDesktopRuntime()
    setDesktopWorkspaceFrozen(runtime, true)
    try { expect((await deleteShared('handoff/note.txt', revision)).status).toBe(409) }
    finally { setDesktopWorkspaceFrozen(runtime, false) }
    const removed = await deleteShared('handoff/note.txt', revision)
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ path: 'handoff/note.txt', workspaceId: 1 })
    expect((await readShared(request('/read?path=handoff/note.txt'))).status).toBe(404)
    await POST(request('', 'POST', form('more.txt', 'inside', 'handoff/nested')))
    const folder = await deleteRevision('', 'handoff')
    expect((await deleteShared('handoff', folder)).status).toBe(200)
    const shared = join(root, 'workspaces', '1', 'engine', 'shared')
    expect((await readdir(shared)).filter(name => !name.startsWith('.'))).toEqual(['keep.txt'])
    expect(await readFile(join(shared, 'keep.txt'), 'utf8')).toBe('keep')
})

test('preserves replacements, edited content, linked entries, and other coworker files', async () => {
    const shared = join(root, 'workspaces', '1', 'engine', 'shared')
    const secret = join(root, 'workspaces', '1', 'engine', 'agents', 'alice', 'workspace', 'secret.txt')
    expect((await POST(request('', 'POST', form('note.txt', 'old', 'handoff')))).status).toBe(201)
    const revision = await deleteRevision('handoff', 'note.txt')
    const note = join(shared, 'handoff', 'note.txt')
    await writeFile(note, 'edited')
    expect((await deleteShared('handoff/note.txt', revision)).status).toBe(409)
    expect(await readFile(note, 'utf8')).toBe('edited')
    const edited = await deleteRevision('handoff', 'note.txt')
    await rename(note, join(shared, 'handoff', 'original.txt'))
    await writeFile(note, 'replacement')
    expect((await deleteShared('handoff/note.txt', edited)).status).toBe(409)
    expect(await readFile(note, 'utf8')).toBe('replacement')
    expect((await deleteShared('../agents/alice/workspace/secret.txt', revision)).status).toBe(400)
    await symlink(join(shared, 'handoff'), join(shared, 'redirect'))
    expect((await deleteShared('redirect/note.txt', edited)).status).toBe(400)
    await link(secret, join(shared, 'handoff', 'alias.txt'))
    const folder = await deleteRevision('', 'handoff')
    expect((await deleteShared('handoff', folder)).status).toBe(409)
    expect(await readFile(note, 'utf8')).toBe('replacement')
    expect(await readFile(secret, 'utf8')).toBe('private-only')
})

test('a new authenticated listing recovers an interrupted shared removal', async () => {
    await POST(request('', 'POST', form('note.txt', 'old', 'handoff')))
    await POST(request('', 'POST', form('keep.txt', 'keep', 'handoff')))
    const revision = await deleteRevision('handoff', 'note.txt')
    vi.stubEnv('RERUN_FILE_DELETE_CRASH', 'staged')
    try { expect((await deleteShared('handoff/note.txt', revision)).status).toBe(500) }
    finally { vi.unstubAllEnvs() }
    const { entries } = await (await GET(request('?path=handoff'))).json()
    expect(entries.map((entry: { name: string }) => entry.name)).toEqual(['keep.txt'])
    const folder = join(root, 'workspaces', '1', 'engine', 'shared', 'handoff')
    expect(await readdir(folder)).toEqual(['keep.txt'])
})

test('an aborted multipart stream is cancelled without importing a file', async () => {
    const controller = new AbortController(), cancelled = vi.fn()
    const sample = request('', 'POST', form('never.txt', 'x', ''))
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const stream = new ReadableStream<Uint8Array>({ pull() { began() }, cancel: cancelled })
    const pending = POST(new Request(sample.url, { method: 'POST', headers: sample.headers, body: stream, signal: controller.signal, duplex: 'half' } as RequestInit))
    await started
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(await (await GET(request('?path='))).json()).toMatchObject({ entries: [] })
})

test('authentication runs before file parsing and multiple files or folders are refused', async () => {
    const unauthenticated = request('', 'POST', form('note.txt', 'x', ''))
    unauthenticated.headers.delete('cookie')
    expect((await POST(unauthenticated)).status).toBe(401)
    const duplicateFiles = form('note.txt', 'x', '')
    duplicateFiles.append('file', new File(['y'], 'other.txt'))
    expect((await POST(request('', 'POST', duplicateFiles))).status).toBe(400)
    const duplicateFolders = form('note.txt', 'x', '')
    duplicateFolders.append('path', 'another')
    expect((await POST(request('', 'POST', duplicateFolders))).status).toBe(400)
})
