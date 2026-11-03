import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { hashText } from '@/lib/files/editable'
import { GET as read } from '../read/route'
import { PUT as save } from './route'

const hooks = vi.hoisted(() => ({
    wrapWrite: undefined as undefined | ((target: string, handle: import('node:fs/promises').FileHandle) => import('node:fs/promises').FileHandle),
    beforeReadOpen: undefined as undefined | ((target: string) => Promise<void>),
    beforeRename: undefined as undefined | (() => Promise<void>),
}))
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    return { ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
            if ((Number(args[1] ?? 0) & 3) === 0) await hooks.beforeReadOpen?.(String(args[0]))
            const handle = await fs.open(...args)
            return hooks.wrapWrite && (Number(args[1] ?? 0) & 3) !== 0 ? hooks.wrapWrite(String(args[0]), handle) : handle
        },
        rename: async (...args: Parameters<typeof fs.rename>) => { await hooks.beforeRename?.(); return fs.rename(...args) },
    }
})

const originalEnv = { ...process.env }
const token = 'f'.repeat(48)
const origin = 'http://127.0.0.1:3190'
let root: string, alice: string, bob: string, cal: string
const workspace = (engineId: string) => join(root, 'workspaces', '1', 'engine', 'agents', engineId, 'workspace')
const put = (id: string, body: unknown) => save(new Request(`${origin}/api/desktop/agents/${id}/files/content`, { method: 'PUT',
    headers: { host: '127.0.0.1:3190', origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
{ params: Promise.resolve({ agentId: id }) })
const preview = async (id: string, path: string) => (await read(new Request(`${origin}/api/desktop/agents/${id}/files/read?path=${encodeURIComponent(path)}`,
    { headers: { host: '127.0.0.1:3190', cookie: `rerun-desktop-session=${token}` } }), { params: Promise.resolve({ agentId: id }) })).json()
const leftovers = async (dir: string) => (await readdir(dir)).filter(name => name.startsWith('.rerun-edit-'))

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-files-edit-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'edit', buildId: 'edit-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    cal = (await createDesktopAgent(db, { engineAgentId: 'engine-cal', name: 'Cal' })).id
    for (const [id, text] of [['engine-alice', '# Alice notes'], ['engine-bob', '# Bob notes']]) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
    }
})
afterEach(async () => {
    hooks.beforeReadOpen = undefined
    hooks.wrapWrite = undefined
    hooks.beforeRename = undefined
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('preview hands out the hash an edit starts from; save replaces only that coworker’s file', async () => {
    const opened = await preview(alice, 'docs/notes.md')
    expect(opened.hash).toBe(hashText('# Alice notes'))
    const response = await put(alice, { path: 'docs/notes.md', content: '# Alice edited', baseHash: opened.hash })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'docs/notes.md', hash: hashText('# Alice edited') })
    expect(await readFile(join(workspace('engine-alice'), 'docs/notes.md'), 'utf8')).toBe('# Alice edited')
    expect(await readFile(join(workspace('engine-bob'), 'docs/notes.md'), 'utf8')).toBe('# Bob notes')
    expect((await preview(alice, 'docs/notes.md')).content).toBe('# Alice edited')
    expect(await leftovers(join(workspace('engine-alice'), 'docs'))).toEqual([])
})

test('a stale base hash keeps the newer disk text and returns it with the conflict', async () => {
    const opened = await preview(bob, 'docs/notes.md')
    await writeFile(join(workspace('engine-bob'), 'docs/notes.md'), '# Bob by the coworker')
    const response = await put(bob, { path: 'docs/notes.md', content: '# Bob by me', baseHash: opened.hash })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ conflict: true, current: { content: '# Bob by the coworker', hash: hashText('# Bob by the coworker') } })
    expect(await readFile(join(workspace('engine-bob'), 'docs/notes.md'), 'utf8')).toBe('# Bob by the coworker')
    // Retrying against the version now shown wins.
    expect((await put(bob, { path: 'docs/notes.md', content: '# Bob by me', baseHash: hashText('# Bob by the coworker') })).status).toBe(200)
    expect(await readFile(join(workspace('engine-bob'), 'docs/notes.md'), 'utf8')).toBe('# Bob by me')
})

test('a change that lands while the save is being written is not overwritten', async () => {
    const opened = await preview(alice, 'docs/notes.md')
    let once = false
    hooks.beforeRename = async () => { if (!once) { once = true } }
    hooks.wrapWrite = (target, handle) => {
        if (!target.includes('.rerun-edit-')) return handle
        const original = handle.sync.bind(handle)
        return Object.assign(handle, { sync: async () => { await original(); await writeFile(join(workspace('engine-alice'), 'docs/notes.md'), '# racing coworker write') } })
    }
    const response = await put(alice, { path: 'docs/notes.md', content: '# mine', baseHash: opened.hash })
    expect(response.status).toBe(409)
    expect(await readFile(join(workspace('engine-alice'), 'docs/notes.md'), 'utf8')).toBe('# racing coworker write')
    expect(await leftovers(join(workspace('engine-alice'), 'docs'))).toEqual([])
})

test('a write that fails part way keeps the original and leaves no partial or temp file', async () => {
    const opened = await preview(alice, 'docs/notes.md')
    hooks.wrapWrite = (target, handle) => !target.includes('.rerun-edit-') ? handle : Object.assign(handle, {
        writeFile: async (data: Uint8Array) => { await handle.write(Buffer.from(data).subarray(0, 3)); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
    })
    const response = await put(alice, { path: 'docs/notes.md', content: '# Alice replaced entirely', baseHash: opened.hash })
    expect(response.status).toBe(500)
    expect(await readFile(join(workspace('engine-alice'), 'docs/notes.md'), 'utf8')).toBe('# Alice notes')
    expect(await leftovers(join(workspace('engine-alice'), 'docs'))).toEqual([])
    hooks.beforeReadOpen = undefined
    hooks.wrapWrite = undefined
    expect((await put(alice, { path: 'docs/notes.md', content: '# retry', baseHash: opened.hash })).status).toBe(200)
    expect(await readFile(join(workspace('engine-alice'), 'docs/notes.md'), 'utf8')).toBe('# retry')
})

test('saving keeps the file’s permissions', async () => {
    const file = join(workspace('engine-alice'), 'docs/notes.md')
    await chmod(file, 0o600)
    expect((await put(alice, { path: 'docs/notes.md', content: 'x', baseHash: hashText('# Alice notes') })).status).toBe(200)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
})

test('redirected folders and links cannot write into another coworker’s workspace', async () => {
    // A folder in Alice's workspace that points at Bob's docs.
    await symlink(join(workspace('engine-bob'), 'docs'), join(workspace('engine-alice'), 'bobdocs'))
    await symlink(join(workspace('engine-bob'), 'docs', 'notes.md'), join(workspace('engine-alice'), 'bob.md'))
    for (const path of ['bobdocs/notes.md', 'bob.md', '../../engine-bob/workspace/docs/notes.md', '/etc/hosts.md']) {
        const response = await put(alice, { path, content: 'pwned', baseHash: null })
        expect([400, 404], path).toContain(response.status)
    }
    // Cal's whole coworker directory redirected at Bob: refused.
    await mkdir(join(root, 'workspaces/1/engine/agents'), { recursive: true })
    await symlink(join(root, 'workspaces/1/engine/agents/engine-bob'), join(root, 'workspaces/1/engine/agents/engine-cal'))
    expect((await put(cal, { path: 'docs/notes.md', content: 'pwned', baseHash: null })).status).toBe(400)
    expect(await readFile(join(workspace('engine-bob'), 'docs/notes.md'), 'utf8')).toBe('# Bob notes')
})

test('a folder swapped for a sibling link after validation cannot redirect the save', async () => {
    const docs = join(workspace('engine-alice'), 'docs')
    hooks.beforeReadOpen = undefined
    hooks.wrapWrite = undefined
    let swapped = false
    hooks.beforeRename = async () => {
        if (swapped) return
        swapped = true
        await rename(docs, `${docs}-moved`)
        await symlink(join(workspace('engine-bob'), 'docs'), docs)
    }
    const response = await put(alice, { path: 'docs/notes.md', content: 'pwned', baseHash: hashText('# Alice notes') })
    // The pinned folder is the one that was validated, so the save lands there (or is refused), never in Bob's.
    expect(await readFile(join(workspace('engine-bob'), 'docs/notes.md'), 'utf8')).toBe('# Bob notes')
    if (response.status === 200) expect(await readFile(join(`${docs}-moved`, 'notes.md'), 'utf8')).toBe('pwned')
    expect((await lstat(docs)).isSymbolicLink()).toBe(true)
})

test('only existing text or Markdown files can be saved', async () => {
    await writeFile(join(workspace('engine-alice'), 'docs', 'run.sh'), 'echo hi')
    await writeFile(join(workspace('engine-alice'), 'docs', 'bin.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    expect((await put(alice, { path: 'docs/run.sh', content: 'x', baseHash: 'opened' })).status).toBe(415)
    expect((await put(alice, { path: 'docs/missing.md', content: 'x', baseHash: 'opened' })).status).toBe(404)
    expect((await put(alice, { path: 'docs/bin.md', content: 'x', baseHash: 'opened' })).status).toBe(415)
    expect((await preview(alice, 'docs/bin.md')).hash).toBeUndefined()
    expect((await put(alice, { path: 'docs/notes.md', content: 'a\u0000b', baseHash: 'opened' })).status).toBe(415)
    expect((await put(alice, { path: 'docs/notes.md', content: 'x'.repeat(256 * 1024 + 1), baseHash: 'opened' })).status).toBe(413)
    expect((await put(alice, { path: 'docs/notes.md' })).status).toBe(400)
    expect(await readFile(join(workspace('engine-alice'), 'docs/notes.md'), 'utf8')).toBe('# Alice notes')
})

test('a save needs the desktop session and same-origin request', async () => {
    const response = await save(new Request(`${origin}/api/desktop/agents/${alice}/files/content`, { method: 'PUT',
        headers: { host: '127.0.0.1:3190', origin: 'http://evil.test', cookie: `rerun-desktop-session=${token}` }, body: JSON.stringify({ path: 'docs/notes.md', content: 'x', baseHash: null }) }),
    { params: Promise.resolve({ agentId: alice }) })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await readFile(join(workspace('engine-alice'), 'docs/notes.md'), 'utf8')).toBe('# Alice notes')
})

test('review simultaneous edits both reach final check on same base', async () => {
    const path = 'docs/notes.md'
    const prev = await preview(alice, path)
    let atRename = 0
    let resume!: () => void
    const both = new Promise<void>(r => { resume = r })
    const timeout = setTimeout(resume, 1200)
    hooks.beforeRename = async () => { if (++atRename === 2) resume(); await both }
    const results = await Promise.all(['first new body', 'second new body'].map(content => put(alice, {path, content, baseHash: prev.hash})))
    clearTimeout(timeout)
    const disk = await readFile(join(workspace('engine-alice'), path), 'utf8')
    console.info('RACE STATUS',results.map(x=>x.status), 'DISK',disk)
    expect(results.map(x=>x.status).sort()).toEqual([200,409])
    const loser = results.find(result => result.status === 409)!
    const current = (await loser.json()).current
    expect(current.content).toBe(disk)
    expect(current.hash).toBe(hashText(disk))
    expect(await leftovers(join(workspace('engine-alice'), 'docs'))).toEqual([])
})
test('review a deletion in the final publish window is preserved', async () => {
    const path = 'docs/notes.md', full = join(workspace('engine-alice'), path)
    const prev = await preview(alice, path)
    hooks.beforeRename = async () => { await rm(full) }
    const response = await put(alice, { path, content: 'stale edit', baseHash: prev.hash })
    expect(response.status).toBe(404)
    await expect(readFile(full, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await leftovers(join(workspace('engine-alice'), 'docs'))).toEqual([])
})
test('review explicit null hash bypasses stale detection without conflict confirmation', async () => {
    const path='docs/notes.md'
    await preview(alice,path)
    await writeFile(join(workspace('engine-alice'),path), 'new disk data')
    const response = await put(alice,{path,content:'overwriting null',baseHash:null})
    console.info('NULL STATUS',response.status,'DISK',await readFile(join(workspace('engine-alice'),path),'utf8'))
    expect(response.status).not.toBe(200)
})
test('review a newly created file in final publish window is preserved',async () => {
    const path='docs/notes.md', full=join(workspace('engine-alice'),path)
    const prev=await preview(alice,path)
    hooks.beforeRename = async () => { await rm(full); await writeFile(full,'external replacement') }
    const response=await put(alice,{path,content:'stale edit',baseHash:prev.hash})
    console.info('REPLACEMENT STATUS',response.status,'DISK',await readFile(full,'utf8'))
    expect(await readFile(full,'utf8')).toBe('external replacement')
})
test('review growth after lstat does not read or return oversized content',async () => {
    const path='docs/notes.md', full=join(workspace('engine-alice'),path)
    const prev=await preview(alice,path)
    hooks.beforeReadOpen=async target=>{ if(target.endsWith('/notes.md')) {hooks.beforeReadOpen=undefined;await writeFile(full,'X'.repeat(400000))} }
    const response=await put(alice,{path,content:'draft',baseHash:prev.hash})
    const body=await response.json()
    console.info('GROWTH STATUS',response.status,'RETURNED',body.current?.content?.length)
    expect(response.status).toBe(413)
})
test('review final publish after directory moved outside selected workspace',async () => {
    const path='docs/notes.md'
    const prev=await preview(alice,path)
    const original=join(workspace('engine-alice'),'docs'), moved=join(workspace('engine-bob'),'formerly-alice')
    hooks.beforeRename=async()=>{ hooks.beforeRename=undefined; await rename(original,moved); await mkdir(original) }
    const response=await put(alice,{path,content:'alice edit',baseHash:prev.hash})
    console.info('OTHER WORKSPACE STATUS',response.status,'DISK',await readFile(join(moved,'notes.md'),'utf8'))
    expect(await readFile(join(moved,'notes.md'),'utf8')).toBe('# Alice notes')
})
