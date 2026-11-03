import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as list } from './route'
import { GET as read } from './read/route'

const race = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((target: unknown) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
        await race.beforeOpen?.(args[0])
        return fs.open(...args)
    } }
})

const originalEnv = { ...process.env }
let root: string, alice: string, bob: string
const token = 'f'.repeat(48)
const workspace = (engineId: string) => join(root, 'workspaces', '1', 'engine', 'agents', engineId, 'workspace')
const call = (handler: typeof list, id: string, query: string, cookie = `rerun-desktop-session=${token}`) =>
    handler(new Request(`http://127.0.0.1:3190/api/desktop/agents/${id}/files${handler === read ? '/read' : ''}?${query}`, { headers: { host: '127.0.0.1:3190', cookie } }), { params: Promise.resolve({ agentId: id }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-files-route-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'files', buildId: 'files-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3190', sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    for (const [id, text] of [['engine-alice', '# Alice notes'], ['engine-bob', '# Bob notes']]) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
        await writeFile(join(workspace(id), '.hidden'), 'secret')
    }
    await writeFile(join(root, 'outside.txt'), 'OUTSIDE')
})
afterEach(async () => {
    race.beforeOpen = undefined
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('lists folders first and hides dotfiles unless asked', async () => {
    const body = await (await call(list, alice, 'path=')).json()
    expect(body.entries.map((e: { name: string; type: string }) => [e.name, e.type])).toEqual([['docs', 'dir']])
    const hidden = await (await call(list, alice, 'path=&hidden=1')).json()
    expect(hidden.entries.map((e: { name: string }) => e.name)).toEqual(['docs', '.hidden'])
})

test('identically named files preview each coworker’s own content', async () => {
    const a = await (await call(read, alice, 'path=docs/notes.md')).json()
    const b = await (await call(read, bob, 'path=docs/notes.md')).json()
    expect(a).toMatchObject({ path: 'docs/notes.md', content: '# Alice notes', truncated: false })
    expect(b.content).toBe('# Bob notes')
})

test('rejects traversal, absolute paths, unknown coworkers, engine ids and missing auth', async () => {
    expect((await call(read, alice, 'path=../../engine-bob/workspace/docs/notes.md')).status).toBe(400)
    expect((await call(read, alice, `path=${encodeURIComponent(join(root, 'outside.txt'))}`)).status).toBe(400)
    expect((await call(list, alice, 'path=..')).status).toBe(400)
    expect((await call(list, 'engine-alice', 'path=')).status).toBe(404)
    expect((await call(read, alice, 'path=docs/notes.md', '')).status).toBe(401)
    expect((await call(read, alice, 'path=docs/missing.md')).status).toBe(404)
    expect((await call(read, alice, 'path=docs')).status).toBe(400)
})

test('symlinks that leave the workspace are hidden from listings and refused on read', async () => {
    const ws = workspace('engine-alice')
    await symlink(join(root, 'outside.txt'), join(ws, 'docs', 'escape.txt'))
    await symlink(workspace('engine-bob'), join(ws, 'bob-link'))
    await symlink(join(ws, 'docs', 'notes.md'), join(ws, 'docs', 'inside-link.md'))
    const docs = await (await call(list, alice, 'path=docs')).json()
    expect(docs.entries.map((e: { name: string }) => e.name)).toEqual(['inside-link.md', 'notes.md'])
    const top = await (await call(list, alice, 'path=')).json()
    expect(top.entries.map((e: { name: string }) => e.name)).toEqual(['docs'])
    expect((await call(read, alice, 'path=docs/escape.txt')).status).toBe(400)
    expect((await call(read, alice, 'path=bob-link/docs/notes.md')).status).toBe(400)
    expect((await call(list, alice, 'path=bob-link/docs')).status).toBe(400)
    expect((await (await call(read, alice, 'path=docs/inside-link.md')).json()).content).toBe('# Alice notes')
})

test('a symlinked workspace root that points elsewhere is refused', async () => {
    const db = await openDesktopDatabase(root)
    const carol = (await createDesktopAgent(db, { engineAgentId: 'engine-carol', name: 'Carol' })).id
    await mkdir(join(root, 'workspaces', '1', 'engine', 'agents', 'engine-carol'), { recursive: true })
    await symlink(workspace('engine-bob'), workspace('engine-carol'))
    expect((await call(list, carol, 'path=')).status).toBe(400)
})

test('a coworker without a workspace yet shows an empty folder; binary files are not previewed', async () => {
    const db = await openDesktopDatabase(root)
    const dave = (await createDesktopAgent(db, { engineAgentId: 'engine-dave', name: 'Dave' })).id
    expect(await (await call(list, dave, 'path=')).json()).toEqual({ path: '', entries: [] })
    await writeFile(join(workspace('engine-alice'), 'blob.bin'), Buffer.from([0, 1, 2, 0]))
    expect((await call(read, alice, 'path=blob.bin')).status).toBe(415)
})

test('a symlink in the coworker workspace ancestry cannot redirect to a sibling', async () => {
    const db = await openDesktopDatabase(root)
    const carol = (await createDesktopAgent(db, { engineAgentId: 'engine-carol', name: 'Carol' })).id
    const agents = join(root, 'workspaces', '1', 'engine', 'agents')
    await symlink(join(agents, 'engine-bob'), join(agents, 'engine-carol'), 'dir')
    expect((await call(read, carol, 'path=docs/notes.md')).status).toBe(400)
    expect((await call(list, carol, 'path=docs')).status).toBe(400)
})

test('a directory replaced with a sibling symlink after path validation cannot redirect a preview', async () => {
    const docs = join(workspace('engine-alice'), 'docs')
    const target = await realpath(join(docs, 'notes.md'))
    let swapped = false
    race.beforeOpen = async path => {
        if (swapped || (path !== target && !(process.platform !== 'darwin' && String(path).endsWith('/docs')))) return
        swapped = true
        await rename(docs, docs + '-original')
        await symlink(join(workspace('engine-bob'), 'docs'), docs, 'dir')
    }
    expect((await call(read, alice, 'path=docs/notes.md')).status).toBe(400)
    expect(swapped).toBe(true)
})
