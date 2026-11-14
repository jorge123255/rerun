import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as list, POST as upload } from './route'
import { GET as read } from './read/route'
import { POST as resolveLink } from './link/route'
import { DELETE as removeCoworker } from '../route'

const race = vi.hoisted(() => ({
    beforeMkdir: undefined as undefined | ((target: unknown) => Promise<void>),
    beforeOpen: undefined as undefined | ((target: unknown) => Promise<void>),
    // Wrap a handle opened for writing, e.g. to fail after a partial write.
    wrapWrite: undefined as undefined | ((target: string, handle: import('node:fs/promises').FileHandle) => import('node:fs/promises').FileHandle),
}))
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    return { ...fs, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
        await race.beforeMkdir?.(args[0])
        return fs.mkdir(...args)
    }, open: async (...args: Parameters<typeof fs.open>) => {
        await race.beforeOpen?.(args[0])
        const handle = await fs.open(...args)
        const flags = Number(args[1] ?? 0)
        return race.wrapWrite && (flags & 3) !== 0 ? race.wrapWrite(String(args[0]), handle) : handle
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
    race.beforeMkdir = undefined
    race.beforeOpen = undefined
    race.wrapWrite = undefined
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

test('resolves only the authenticated coworker’s file links and reveals no foreign file status', async () => {
    const resolve = (agentId: string, href: string, cookie = `rerun-desktop-session=${token}`, origin = 'http://127.0.0.1:3190') =>
        resolveLink(new Request(`http://127.0.0.1:3190/api/desktop/agents/${agentId}/files/link`, {
            method: 'POST', headers: { host: '127.0.0.1:3190', cookie, origin, 'content-type': 'application/json' },
            body: JSON.stringify({ href }),
        }), { params: Promise.resolve({ agentId }) })
    const aliceLink = '/data/agents/engine-alice/workspace/docs/notes.md'
    const valid = await resolve(alice, aliceLink)
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ path: 'docs/notes.md' })
    expect((await resolve(alice, aliceLink, '')).status).toBe(401)
    expect((await resolve(alice, aliceLink, undefined, 'https://example.invalid')).status).toBe(403)
    expect((await resolve(alice, aliceLink.replace('/docs/', '/%2e%2e/'))).status).toBe(400)
    for (const link of [
        '/data/agents/engine-bob/workspace/docs/notes.md',
        '/data/agents/engine-bob/workspace/docs/missing.md',
        '/data/agents/engine-bob/workspace/agents/engine-alice/workspace/docs/notes.md',
    ]) {
        const denied = await resolve(alice, link)
        expect(denied.status).toBe(404)
        expect(await denied.json()).toMatchObject({ error: 'File not found' })
    }
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

const importFile = (id: string, path: string, name: string, text: string | Uint8Array<ArrayBuffer>, origin = 'http://127.0.0.1:3190') => {
    const form = new FormData()
    form.set('path', path)
    form.set('file', new File([text], name))
    return upload(new Request(`http://127.0.0.1:3190/api/desktop/agents/${id}/files`, { method: 'POST', body: form,
        headers: { host: '127.0.0.1:3190', origin, cookie: `rerun-desktop-session=${token}` } }), { params: Promise.resolve({ agentId: id }) })
}

test('imports same-named files into each coworker’s current folder', async () => {
    const a = await importFile(alice, 'docs', 'brief.md', '# Alice brief')
    expect(a.status).toBe(201)
    expect(await a.json()).toEqual({ path: 'docs/brief.md', name: 'brief.md' })
    expect((await importFile(bob, 'docs', 'brief.md', '# Bob brief')).status).toBe(201)
    expect((await (await call(read, alice, 'path=docs/brief.md')).json()).content).toBe('# Alice brief')
    expect((await (await call(read, bob, 'path=docs/brief.md')).json()).content).toBe('# Bob brief')
    expect((await importFile(alice, '', 'top.txt', 'top')).status).toBe(201)
    expect(await readFile(join(workspace('engine-alice'), 'top.txt'), 'utf8')).toBe('top')
})

test('an existing name is preserved and reported', async () => {
    const response = await importFile(alice, 'docs', 'notes.md', 'REPLACED')
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/already has a file named “notes\.md”/)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('# Alice notes')
})

test('only one text or Markdown file with a plain name', async () => {
    expect((await importFile(alice, 'docs', 'run.sh', 'x')).status).toBe(415)
    expect((await importFile(alice, 'docs', 'bin.txt', new Uint8Array([0, 1]))).status).toBe(415)
    expect((await importFile(alice, 'docs', '.env.md', 'x')).status).toBe(400)
    expect((await importFile(alice, 'docs', '../x.md', 'x')).status).toBe(400)
    expect((await importFile(alice, 'docs', 'x.md', 'x', 'http://evil.test')).status).toBe(403)
    expect((await importFile(alice, 'missing', 'x.md', 'x')).status).toBe(404)
})

test('a redirected folder cannot write into another coworker’s workspace', async () => {
    const ws = workspace('engine-alice')
    await symlink(join(workspace('engine-bob'), 'docs'), join(ws, 'bob-docs'), 'dir')
    await symlink(join(root), join(ws, 'up'), 'dir')
    expect((await importFile(alice, 'bob-docs', 'evil.md', 'EVIL')).status).toBe(400)
    expect((await importFile(alice, 'up', 'evil.md', 'EVIL')).status).toBe(400)
    expect((await importFile(alice, '../../engine-bob/workspace/docs', 'evil.md', 'EVIL')).status).toBe(400)
    await symlink(join(workspace('engine-bob'), 'docs', 'target.md'), join(ws, 'docs', 'dangling.md'))
    expect((await importFile(alice, 'docs', 'dangling.md', 'EVIL')).status).toBe(409)
    await expect(readFile(join(workspace('engine-bob'), 'docs', 'evil.md'))).rejects.toThrow()
    await expect(readFile(join(workspace('engine-bob'), 'docs', 'target.md'))).rejects.toThrow()
})

test('a folder swapped for a sibling symlink after validation cannot redirect an import', async () => {
    const docs = join(workspace('engine-alice'), 'docs')
    let swapped = false
    race.beforeOpen = async path => {
        if (swapped || !(String(path).includes('/.rerun-import-') || (process.platform !== 'darwin' && String(path).endsWith('/docs')))) return
        swapped = true
        await rename(docs, docs + '-original')
        await symlink(join(workspace('engine-bob'), 'docs'), docs, 'dir')
    }
    expect((await importFile(alice, 'docs', 'swap.md', 'EVIL')).status).toBe(400)
    expect(swapped).toBe(true)
    await expect(readFile(join(workspace('engine-bob'), 'docs', 'swap.md'))).rejects.toThrow()
})

const exists = (path: string) => lstat(path).then(() => true, () => false)

test('a coworker directory redirected to a sibling without a workspace is refused before anything is created', async () => {
    const db = await openDesktopDatabase(root)
    const erin = (await createDesktopAgent(db, { engineAgentId: 'engine-erin', name: 'Erin' })).id
    await createDesktopAgent(db, { engineAgentId: 'engine-frank', name: 'Frank' })
    const agents = join(root, 'workspaces', '1', 'engine', 'agents')
    await mkdir(join(agents, 'engine-frank'))
    await symlink(join(agents, 'engine-frank'), join(agents, 'engine-erin'), 'dir')
    expect((await importFile(erin, '', 'brief.md', 'EVIL')).status).toBe(400)
    expect(await readdir(join(agents, 'engine-frank'))).toEqual([])
    expect(await exists(workspace('engine-frank'))).toBe(false)
    // A dangling redirect to a sibling that does not exist at all creates nothing either.
    const gail = (await createDesktopAgent(db, { engineAgentId: 'engine-gail', name: 'Gail' })).id
    await symlink(join(agents, 'engine-hank'), join(agents, 'engine-gail'), 'dir')
    expect((await importFile(gail, '', 'brief.md', 'EVIL')).status).toBe(400)
    expect(await exists(join(agents, 'engine-hank'))).toBe(false)
})

test('a coworker without a workspace yet gets one on first import', async () => {
    const db = await openDesktopDatabase(root)
    const ivy = (await createDesktopAgent(db, { engineAgentId: 'engine-ivy', name: 'Ivy' })).id
    expect((await importFile(ivy, '', 'first.md', '# Ivy')).status).toBe(201)
    expect(await readFile(join(workspace('engine-ivy'), 'first.md'), 'utf8')).toBe('# Ivy')
})

const failAfterPartialWrite = (gate?: Promise<void>) => (_target: string, handle: import('node:fs/promises').FileHandle) => {
    const partial = async (data: Uint8Array | string) => {
        await handle.write(Buffer.from(data as Uint8Array).subarray(0, 3))
        await gate
        throw Object.assign(new Error('EIO: simulated disk failure'), { code: 'EIO' })
    }
    return new Proxy(handle, { get: (h, key) => {
        if (key === 'writeFile' || key === 'write') return partial
        const value = Reflect.get(h, key)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(h) : value
    } })
}

test('a write that fails part way leaves the name free for retry and no partial file', async () => {
    race.wrapWrite = failAfterPartialWrite()
    expect((await importFile(alice, 'docs', 'retry.md', '# Complete content')).status).toBe(500)
    const docs = join(workspace('engine-alice'), 'docs')
    expect(await exists(join(docs, 'retry.md'))).toBe(false)
    expect((await readdir(docs)).sort()).toEqual(['notes.md'])
    race.wrapWrite = undefined
    expect((await importFile(alice, 'docs', 'retry.md', '# Complete content')).status).toBe(201)
    expect(await readFile(join(docs, 'retry.md'), 'utf8')).toBe('# Complete content')
})

test('a failed write never touches an existing file with the same name', async () => {
    race.wrapWrite = failAfterPartialWrite()
    expect((await importFile(alice, 'docs', 'notes.md', 'REPLACED')).status).not.toBe(201)
    expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('# Alice notes')
})

test('a queued import waits for a partial failed write, then publishes complete bytes under the same name', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let opened!: () => void
    const writing = new Promise<void>(resolve => { opened = resolve })
    let first = true
    race.wrapWrite = (target, handle) => {
        if (!first) return handle
        first = false
        opened()
        return failAfterPartialWrite(gate)(target, handle)
    }
    const slow = importFile(alice, 'docs', 'race.md', 'SLOW-AND-FAILS')
    let queued: Promise<Response> | undefined
    try {
        await writing
        let queuedFinished = false
        queued = importFile(alice, 'docs', 'race.md', '# Winner').then(response => { queuedFinished = true; return response })
        await new Promise(r => setTimeout(r, 30))
        expect(queuedFinished).toBe(false)
        expect(await exists(join(workspace('engine-alice'), 'docs', 'race.md'))).toBe(false)
        release()
        expect((await slow).status).toBe(500)
        expect((await queued).status).toBe(201)
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'race.md'), 'utf8')).toBe('# Winner')
    } finally {
        release()
        await Promise.allSettled([slow, ...(queued ? [queued] : [])])
    }
})

test('Delete waits for an admitted import; an old file picker cannot recreate the deleted coworker', async () => {
    let release!: () => void, opened!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const writing = new Promise<void>(resolve => { opened = resolve })
    race.wrapWrite = (_target, handle) => new Proxy(handle, { get: (h, key) => {
        if (key === 'writeFile') return async (bytes: Uint8Array) => { opened(); await gate; return handle.writeFile(bytes) }
        const value = Reflect.get(h, key)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(h) : value
    } })
    let engineDeletes = 0
    const server = createServer(async (req, res) => {
        try {
            expect(req.method).toBe('DELETE')
            expect(req.url).toBe('/agents/engine-alice')
            engineDeletes++
            expect(await readFile(join(workspace('engine-alice'), 'docs', 'final.md'), 'utf8')).toBe('Complete before Delete')
            await rm(join(workspace('engine-alice'), '..'), { recursive: true, force: true })
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ deleted: 'engine-alice' }))
        } catch { res.writeHead(500).end() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
    runtime.engine.origin = `http://127.0.0.1:${address.port}`
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime))
    const importing = importFile(alice, 'docs', 'final.md', 'Complete before Delete')
    let deleting: Promise<Response> | undefined
    try {
        await writing
        deleting = removeCoworker(new Request(`http://127.0.0.1:3190/api/desktop/agents/${alice}`, {
            method: 'DELETE', headers: { host: '127.0.0.1:3190', origin: 'http://127.0.0.1:3190', cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ confirmationName: 'Alice' }),
        }), { params: Promise.resolve({ agentId: alice }) })
        await new Promise(r => setTimeout(r, 30))
        expect(engineDeletes).toBe(0)
        release()
        expect((await importing).status).toBe(201)
        expect((await deleting).status).toBe(200)
        expect(engineDeletes).toBe(1)
        expect(await exists(join(workspace('engine-alice'), '..'))).toBe(false)
        expect((await importFile(alice, '', 'late.md', 'Must not recreate')).status).toBe(404)
        expect(await exists(join(workspace('engine-alice'), '..'))).toBe(false)
        expect(await readFile(join(workspace('engine-bob'), 'docs', 'notes.md'), 'utf8')).toBe('# Bob notes')
    } finally {
        release()
        await Promise.allSettled([importing, ...(deleting ? [deleting] : [])])
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})

test('two complete imports racing for one name: exactly one wins and is never overwritten', async () => {
    for (let i = 0; i < 10; i++) {
        const name = `both-${i}.md`
        const [a, b] = await Promise.all([importFile(alice, 'docs', name, 'AAAA'), importFile(alice, 'docs', name, 'BBBB')])
        expect([a.status, b.status].sort()).toEqual([201, 409])
        expect(await readFile(join(workspace('engine-alice'), 'docs', name), 'utf8')).toBe(a.status === 201 ? 'AAAA' : 'BBBB')
    }
    expect((await readdir(join(workspace('engine-alice'), 'docs'))).filter(n => n.startsWith('.'))).toEqual([])
})

test('a parent swapped after validation cannot create a sibling workspace on first import', async () => {
    const agents = join(root, 'workspaces', '1', 'engine', 'agents')
    const owner = join(agents, 'engine-new')
    const sibling = join(agents, 'engine-empty')
    const db = await openDesktopDatabase(root)
    const actor = (await createDesktopAgent(db, { engineAgentId: 'engine-new', name: 'New' })).id
    await createDesktopAgent(db, { engineAgentId: 'engine-empty', name: 'Empty' })
    await mkdir(owner)
    await mkdir(sibling)
    let swapped = false
    race.beforeMkdir = async target => {
        if (swapped || !String(target).endsWith('/workspace')) return
        swapped = true
        await rename(owner, owner + '-before')
        await symlink(sibling, owner, 'dir')
    }
    const res = await importFile(actor, '', 'note.txt', 'private')
    expect(swapped).toBe(true)
    expect(res.status).toBe(400)
    expect(await readdir(sibling)).toEqual([])
})
test('a legal long filename is importable', async () => {
    const name = 'n'.repeat(235) + '.txt'
    const res = await importFile(alice, 'docs', name, 'complete')
    expect(res.status).toBe(201)
    expect(await readFile(join(workspace('engine-alice'), 'docs', name), 'utf8')).toBe('complete')
})
