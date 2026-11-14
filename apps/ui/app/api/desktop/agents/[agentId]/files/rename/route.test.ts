import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET as list } from '../route'
import { GET as read } from '../read/route'
import { PUT as save } from '../content/route'
import { POST } from './route'

const hooks = vi.hoisted(() => ({
    beforeMove: undefined as undefined | ((args: readonly string[]) => Promise<void>),
    afterJournalRead: undefined as undefined | (() => Promise<void>),
}))
vi.mock('node:child_process', async importOriginal => {
    const child = await importOriginal<typeof import('node:child_process')>()
    const { promisify } = await import('node:util')
    const exec = child.execFile.bind(child)
    Object.defineProperty(exec, promisify.custom, { value: async (command: string, args: string[], options: object) => {
        if (command === process.env.RERUN_DESKTOP_RENAME_HELPER) await hooks.beforeMove?.(args)
        return new Promise((resolve, reject) => child.execFile(command, args, options, (error, stdout, stderr) => {
            if (error) reject(Object.assign(error, { stdout, stderr }))
            else resolve({ stdout, stderr })
        }))
    } })
    return { ...child, execFile: exec }
})
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if ((Number(args[1]) & 3) === 0 && String(args[0]).includes('/.rerun-rename-') && String(args[0]).endsWith('.json') && hooks.afterJournalRead) {
            const hook = hooks.afterJournalRead; hooks.afterJournalRead = undefined
            const close = handle.close.bind(handle)
            return Object.assign(handle, { close: async () => { await close(); await hook() } })
        }
        return handle
    } }
})

const env = { ...process.env }
const origin = 'http://127.0.0.1:3190', token = 'f'.repeat(48)
let root: string, alice: string, bob: string
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')
function request(id: string, suffix: string, method = 'GET', body?: object, cookie = token) {
    return new Request(`${origin}/api/desktop/agents/${id}/files${suffix}`, { method, headers: {
        host: '127.0.0.1:3190', origin, cookie: `rerun-desktop-session=${cookie}`, 'content-type': 'application/json',
    }, body: body && JSON.stringify(body) })
}
const renameFile = (path: string, name: string, id = alice) => POST(request(id, '/rename', 'POST', { path, name }), { params: Promise.resolve({ agentId: id }) })
const listing = (path = 'docs', id = alice) => list(request(id, `?path=${encodeURIComponent(path)}`), { params: Promise.resolve({ agentId: id }) })
const preview = async (path = 'docs/notes.md') => (await read(request(alice, `/read?path=${encodeURIComponent(path)}`), { params: Promise.resolve({ agentId: alice }) })).json()
const put = (body: object) => save(request(alice, '/content', 'PUT', body), { params: Promise.resolve({ agentId: alice }) })

// Root supplies the freshly compiled helper; the fixture uses its real no-replace syscalls.
describe.runIf(!!process.env.RERUN_DESKTOP_RENAME_HELPER)('confined desktop rename with the native helper', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'rerun-rename-api-'))
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'rename', buildId: 'rename-test', workspaceId: 1, dataRoot: root,
            app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
        const db = await openDesktopDatabase(root)
        alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
        bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
        for (const [id, text] of [['engine-alice', 'Alice bytes'], ['engine-bob', 'Bob bytes']]) {
            await mkdir(join(workspace(id), 'docs'), { recursive: true })
            await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
        }
    })
    afterEach(async () => {
        hooks.beforeMove = undefined; hooks.afterJournalRead = undefined
        await closeDesktopDatabase(root); process.env = { ...env }
        await rm(root, { recursive: true, force: true })
    })

    test('renames a file and directory, preserving identities, bytes and the other coworker after reopening the database', async () => {
        const opened = await preview()
        expect((await renameFile('docs/notes.md', 'brief.md')).status).toBe(200)
        expect(await preview('docs/brief.md')).toMatchObject({ content: 'Alice bytes', identity: opened.identity })
        expect((await renameFile('docs', 'Documents')).status).toBe(200)
        await closeDesktopDatabase(root)
        expect(await preview('Documents/brief.md')).toMatchObject({ content: 'Alice bytes', identity: opened.identity })
        expect(await readFile(join(workspace('engine-bob'), 'docs', 'notes.md'), 'utf8')).toBe('Bob bytes')
        expect((await (await listing('docs', bob)).json()).entries.map((item: { name: string }) => item.name)).toEqual(['notes.md'])
    })

    test('supports actual-volume case-only file and folder names without leaving hidden stages', async () => {
        expect((await renameFile('docs/notes.md', 'NOTES.md')).status).toBe(200)
        expect(await readdir(join(workspace('engine-alice'), 'docs'))).toEqual(['NOTES.md'])
        expect((await renameFile('docs', 'DOCS')).status).toBe(200)
        expect(await readdir(workspace('engine-alice'))).toEqual(['DOCS'])
        expect(await readFile(join(workspace('engine-alice'), 'DOCS', 'NOTES.md'), 'utf8')).toBe('Alice bytes')
    })

    test('rejects unauthenticated requests, traversal, paths in the new name, symlinks and occupied destinations', async () => {
        expect((await POST(request(alice, '/rename', 'POST', { path: 'docs/notes.md', name: 'new.md' }, ''), { params: Promise.resolve({ agentId: alice }) })).status).toBe(401)
        for (const name of ['../outside.md', '/outside.md', 'nested/name.md', 'nested\\name.md', '.', '..', '.rerun-rename-forged']) expect((await renameFile('docs/notes.md', name)).status).toBe(400)
        expect((await renameFile('../engine-bob/workspace/docs/notes.md', 'new.md')).status).toBe(400)
        await writeFile(join(workspace('engine-alice'), 'docs', 'taken.md'), 'Destination')
        expect((await renameFile('docs/notes.md', 'taken.md')).status).toBe(409)
        await symlink(join(workspace('engine-bob'), 'docs', 'notes.md'), join(workspace('engine-alice'), 'docs', 'link.md'))
        expect((await renameFile('docs/link.md', 'new.md')).status).toBe(400)
        expect((await renameFile('docs/notes.md', 'link.md')).status).not.toBe(200)
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('Alice bytes')
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'taken.md'), 'utf8')).toBe('Destination')
    })

    test('a destination arriving immediately before exclusive publication wins without replacing either file', async () => {
        hooks.beforeMove = async args => {
            if (args[6] !== 'new.md') return
            hooks.beforeMove = undefined
            await writeFile(join(workspace('engine-alice'), 'docs', 'new.md'), 'Newer destination')
        }
        expect((await renameFile('docs/notes.md', 'new.md')).status).toBe(409)
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('Alice bytes')
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'new.md'), 'utf8')).toBe('Newer destination')
    })

    test('arrivals at both old and new names preserve the staged original as a visible recovery file', async () => {
        hooks.beforeMove = async args => {
            if (args[6] !== 'new.md') return
            hooks.beforeMove = undefined
            await writeFile(join(workspace('engine-alice'), 'docs', 'new.md'), 'Newer destination')
            await writeFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'Newer source')
        }
        const response = await renameFile('docs/notes.md', 'new.md')
        expect(response.status).toBe(409)
        expect((await response.json()).error).toContain('rename-recovery-')
        const dir = join(workspace('engine-alice'), 'docs'), names = await readdir(dir)
        expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('Newer source')
        expect(await readFile(join(dir, 'new.md'), 'utf8')).toBe('Newer destination')
        expect(await readFile(join(dir, names.find(name => name.startsWith('rename-recovery-'))!), 'utf8')).toBe('Alice bytes')
    })

    test('refuses to rename a different entry from the one selected in Files', async () => {
        const dir = join(workspace('engine-alice'), 'docs')
        const opened = await preview()
        await rename(join(dir, 'notes.md'), join(dir, 'original.md'))
        await writeFile(join(dir, 'notes.md'), 'The replacement')
        const attempt = (identity: string) => POST(request(alice, '/rename', 'POST',
            { path: 'docs/notes.md', name: 'brief.md', identity }), { params: Promise.resolve({ agentId: alice }) })

        expect((await attempt(opened.identity)).status).toBe(409)
        expect((await attempt('invalid')).status).toBe(400)
        expect(await readdir(dir)).toEqual(['notes.md', 'original.md'])
        expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('The replacement')
        expect(await readFile(join(dir, 'original.md'), 'utf8')).toBe('Alice bytes')
        expect((await attempt((await preview()).identity)).status).toBe(200)
        expect(await preview('docs/brief.md')).toMatchObject({ content: 'The replacement' })
    })

    test('a source replaced before native admission is not moved or overwritten', async () => {
        hooks.beforeMove = async args => {
            if (args[3] !== 'notes.md') return
            hooks.beforeMove = undefined
            const dir = join(workspace('engine-alice'), 'docs')
            await rename(join(dir, 'notes.md'), join(dir, 'original.md'))
            await writeFile(join(dir, 'notes.md'), 'Atomic writer replacement')
        }
        expect((await renameFile('docs/notes.md', 'new.md')).status).toBe(409)
        const dir = join(workspace('engine-alice'), 'docs')
        expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('Atomic writer replacement')
        expect(await readFile(join(dir, 'original.md'), 'utf8')).toBe('Alice bytes')
        expect(await readdir(dir)).not.toContain('new.md')
    })

    async function journal() {
        const dir = await realpath(join(workspace('engine-alice'), 'docs')), parent = await lstat(dir, { bigint: true })
        const source = await lstat(join(dir, 'notes.md'), { bigint: true })
        const temp = '.rerun-rename-fixture', name = temp + '.json'
        await writeFile(join(dir, name), JSON.stringify({ v: 2, from: 'notes.md', temp, to: 'new.md', dev: String(source.dev), ino: String(source.ino), parentDev: String(parent.dev), parentIno: String(parent.ino) }))
        await rename(join(dir, 'notes.md'), join(dir, temp))
        return { dir, temp, name }
    }

    test('a staged rename recovers on listing after restart and keeps the same inode', async () => {
        const opened = await preview(), state = await journal()
        await closeDesktopDatabase(root)
        expect((await listing()).status).toBe(200)
        expect(await preview('docs/new.md')).toMatchObject({ content: 'Alice bytes', identity: opened.identity })
        expect(await readdir(state.dir)).toEqual(['new.md'])
    })

    test('a mismatched staged inode becomes visible recovery after restart without changing any ordinary names', async () => {
        const state = await journal()
        await rename(join(state.dir, state.temp), join(state.dir, 'original-kept.md'))
        await writeFile(join(state.dir, state.temp), 'Intermediate writer replacement')
        await writeFile(join(state.dir, 'notes.md'), 'Newest source arrival')
        await writeFile(join(state.dir, 'new.md'), 'Newest destination arrival')
        const staged = await lstat(join(state.dir, state.temp), { bigint: true })
        await closeDesktopDatabase(root)
        const response = await listing()
        expect(response.status).toBe(409)
        expect((await response.json()).error).toContain('rename-recovery-')
        const names = await readdir(state.dir), recovered = names.find(name => name.startsWith('rename-recovery-'))!
        expect(recovered).toBeDefined()
        expect(await readFile(join(state.dir, recovered), 'utf8')).toBe('Intermediate writer replacement')
        expect((await lstat(join(state.dir, recovered), { bigint: true })).ino).toBe(staged.ino)
        expect(await readFile(join(state.dir, 'original-kept.md'), 'utf8')).toBe('Alice bytes')
        expect(await readFile(join(state.dir, 'notes.md'), 'utf8')).toBe('Newest source arrival')
        expect(await readFile(join(state.dir, 'new.md'), 'utf8')).toBe('Newest destination arrival')
        expect(names).not.toContain(state.temp)
        expect(names).not.toContain(state.name)
        const refreshed = await listing()
        expect(refreshed.status).toBe(200)
        expect((await refreshed.json()).entries.map((entry: { name: string }) => entry.name)).toContain(recovered)
        expect(await readFile(join(workspace('engine-bob'), 'docs', 'notes.md'), 'utf8')).toBe('Bob bytes')
    })

    test('recovery rechecks ownership after reading its journal and does not mutate a folder moved to another coworker', async () => {
        const state = await journal(), moved = join(workspace('engine-bob'), 'moved')
        hooks.afterJournalRead = async () => { await rename(state.dir, moved); await mkdir(state.dir) }
        expect((await listing()).status).toBe(400)
        expect(await readdir(moved)).toEqual(expect.arrayContaining([state.name, state.temp]))
        expect(await readFile(join(moved, state.temp), 'utf8')).toBe('Alice bytes')
        expect(await readdir(moved)).not.toContain('new.md')
        expect(await readdir(state.dir)).toEqual([])
    })

    test('recovery preserves a destination that arrives after journal inspection', async () => {
        const state = await journal()
        hooks.beforeMove = async args => {
            if (args[6] !== 'new.md') return
            hooks.beforeMove = undefined
            await writeFile(join(state.dir, 'new.md'), 'Recovery destination winner')
        }
        expect((await listing()).status).toBe(200)
        expect(await readFile(join(state.dir, 'new.md'), 'utf8')).toBe('Recovery destination winner')
        expect(await readFile(join(state.dir, 'notes.md'), 'utf8')).toBe('Alice bytes')
    })

    test('an old editor cannot overwrite a same-byte replacement after rename, even if the renamed inode was deleted', async () => {
        const opened = await preview()
        expect((await renameFile('docs/notes.md', 'new.md')).status).toBe(200)
        await writeFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'Alice bytes')
        await rm(join(workspace('engine-alice'), 'docs', 'new.md'))
        const response = await put({ path: 'docs/notes.md', content: 'Stale edit', baseHash: opened.hash, identity: opened.identity })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ conflict: true, stale: true })
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('Alice bytes')
    })
})
