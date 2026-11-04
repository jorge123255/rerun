import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { GET as list } from '../route'
import { GET as read } from '../read/route'
import { POST } from './route'

const hooks = vi.hoisted(() => ({ beforeMove: undefined as undefined | ((args: readonly string[]) => Promise<void>) }))
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

const env = { ...process.env }
const origin = 'http://127.0.0.1:3191', token = 'e'.repeat(48)
let root: string, alice: string, bob: string
const workspace = (id: string) => join(root, 'workspaces', '1', 'engine', 'agents', id, 'workspace')
function request(id: string, suffix: string, method = 'GET', body?: object, cookie = token) {
    return new Request(`${origin}/api/desktop/agents/${id}/files${suffix}`, { method, headers: {
        host: '127.0.0.1:3191', origin, cookie: `rerun-desktop-session=${cookie}`, 'content-type': 'application/json',
    }, body: body && JSON.stringify(body) })
}
const remove = (path: string, identity?: string, id = alice) => POST(request(id, '/delete', 'POST', { path, ...(identity && { identity }) }), { params: Promise.resolve({ agentId: id }) })
const listing = (path = 'docs', id = alice) => list(request(id, `?path=${encodeURIComponent(path)}`), { params: Promise.resolve({ agentId: id }) })
const preview = (path: string) => read(request(alice, `/read?path=${encodeURIComponent(path)}`), { params: Promise.resolve({ agentId: alice }) })
const names = async (dir: string) => (await readdir(dir)).filter(name => !name.startsWith('.rerun-delete-'))

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-delete-api-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    delete process.env.RERUN_FILE_DELETE_CRASH
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'delete', buildId: 'delete-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'engine-bob', name: 'Bob' })).id
    const session = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'engine-session', title: 'Chat' })).id
    await db.execute({ sql: `INSERT INTO desktop_composer_drafts (agent_id, tab_uid, revision, text, attachment_path, updated_at) VALUES (?, 'live', 4, 'Read the note', 'docs/notes.md', '2026-11-04T00:00:00.000Z')`, args: [alice] })
    await db.execute({ sql: `INSERT INTO desktop_queued_messages (agent_id, target, session_id, message_id, payload) VALUES (?, 'chat', ?, 'queued-1', ?)`, args: [alice, session, JSON.stringify({ text: 'Read the note', attachmentPath: 'docs/notes.md' })] })
    for (const [id, text] of [['engine-alice', 'Alice bytes'], ['engine-bob', 'Bob bytes']] as const) {
        await mkdir(join(workspace(id), 'docs', 'nested'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
        await writeFile(join(workspace(id), 'docs', 'other.md'), `${text} sibling`)
        await writeFile(join(workspace(id), 'docs', 'nested', 'deep.md'), `${text} deep`)
        await writeFile(join(workspace(id), 'keep.txt'), `${text} keep`)
    }
})
afterEach(async () => {
    hooks.beforeMove = undefined
    await closeDesktopDatabase(root)
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

describe('confined desktop delete guards', () => {
    test('rejects an unsigned request, the workspace root, traversal, symlinks and recovery names without changing bytes', async () => {
        expect((await POST(request(alice, '/delete', 'POST', { path: 'docs/notes.md' }, ''), { params: Promise.resolve({ agentId: alice }) })).status).toBe(401)
        expect((await remove('')).status).toBe(400)
        expect((await remove('../engine-bob/workspace/docs/notes.md')).status).toBe(400)
        expect((await remove('docs/../../engine-bob/workspace/docs/notes.md')).status).toBe(400)
        await symlink(join(workspace('engine-bob'), 'docs', 'notes.md'), join(workspace('engine-alice'), 'docs', 'link.md'))
        expect((await remove('docs/link.md')).status).toBe(400)
        expect((await lstat(join(workspace('engine-alice'), 'docs', 'link.md'))).isSymbolicLink()).toBe(true)
        await symlink(join(workspace('engine-bob'), 'docs', 'notes.md'), join(workspace('engine-alice'), 'docs', 'nested', 'link.md'))
        expect((await remove('docs')).status).toBe(409)
        await writeFile(join(workspace('engine-alice'), 'docs', '.rerun-edit-secret'), 'recovery')
        expect((await remove('docs/.rerun-edit-secret')).status).toBe(400)
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('Alice bytes')
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'other.md'), 'utf8')).toBe('Alice bytes sibling')
        expect(await readFile(join(workspace('engine-bob'), 'docs', 'notes.md'), 'utf8')).toBe('Bob bytes')
        expect(await readFile(join(workspace('engine-alice'), 'keep.txt'), 'utf8')).toBe('Alice bytes keep')
    })

    test('an identity from the list does not delete a file that replaced that inode', async () => {
        const entries = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
        const identity = entries.find(entry => entry.name === 'notes.md')?.identity
        expect(identity).toMatch(/^\d+:\d+$/)
        await writeFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'replaced bytes')
        const replaced = join(workspace('engine-alice'), 'docs', 'notes.md')
        await writeFile(replaced + '.hold', await readFile(replaced))
        await rm(replaced)
        await writeFile(replaced, 'newer occupant')
        expect((await remove('docs/notes.md', identity)).status).toBe(409)
        expect(await readFile(replaced, 'utf8')).toBe('newer occupant')
        expect(await readFile(replaced + '.hold', 'utf8')).toBe('replaced bytes')
        expect((await readdir(join(workspace('engine-alice'), 'docs'))).filter(name => name.startsWith('.rerun-delete-'))).toEqual([])
    })

    test('removes an empty folder without the rename helper and leaves the sibling folder', async () => {
        await mkdir(join(workspace('engine-alice'), 'empty'))
        expect((await remove('empty')).status).toBe(200)
        expect(await readdir(workspace('engine-alice'))).not.toContain('empty')
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('Alice bytes')
    })
})

describe.runIf(!!process.env.RERUN_DESKTOP_RENAME_HELPER)('confined desktop delete with the native helper', () => {
    test('deletes only the selected file and keeps the composer path, queued payload, sibling and other coworker', async () => {
        const entries = ((await (await listing()).json()) as { entries: { name: string; identity: string }[] }).entries
        const identity = entries.find(entry => entry.name === 'notes.md')?.identity
        expect((await remove('docs/notes.md', identity)).status).toBe(200)
        await expect(readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await preview('docs/notes.md')).status).toBe(404)
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'other.md'), 'utf8')).toBe('Alice bytes sibling')
        expect(await readFile(join(workspace('engine-bob'), 'docs', 'notes.md'), 'utf8')).toBe('Bob bytes')
        expect(await names(join(workspace('engine-alice'), 'docs'))).toEqual(expect.arrayContaining(['other.md', 'nested']))
        const db = await openDesktopDatabase(root)
        expect((await db.execute({ sql: 'SELECT revision, text, attachment_path FROM desktop_composer_drafts WHERE agent_id = ?', args: [alice] })).rows[0]).toMatchObject({ revision: 4, text: 'Read the note', attachment_path: 'docs/notes.md' })
        expect((await db.execute({ sql: 'SELECT payload FROM desktop_queued_messages WHERE agent_id = ?', args: [alice] })).rows[0]?.payload).toBe(JSON.stringify({ text: 'Read the note', attachmentPath: 'docs/notes.md' }))
        await closeDesktopDatabase(root)
        expect((await preview('docs/other.md')).status).toBe(200)
    })

    test('deletes a folder of ordinary files and leaves the coworker root and the other coworker', async () => {
        expect((await remove('docs')).status).toBe(200)
        expect(await readdir(workspace('engine-alice'))).toEqual(['keep.txt'])
        expect(await readFile(join(workspace('engine-alice'), 'keep.txt'), 'utf8')).toBe('Alice bytes keep')
        expect(await readFile(join(workspace('engine-bob'), 'docs', 'nested', 'deep.md'), 'utf8')).toBe('Bob bytes deep')
    })

    test('a stop after the private name is staged finishes on the next listing and does not remove the sibling', async () => {
        process.env.RERUN_FILE_DELETE_CRASH = 'staged'
        expect((await remove('docs/notes.md')).status).toBe(500)
        const staged = (await readdir(join(workspace('engine-alice'), 'docs'))).filter(name => name.startsWith('.rerun-delete-'))
        expect(staged.some(name => name.endsWith('.json'))).toBe(true)
        expect(staged.some(name => !name.endsWith('.json'))).toBe(true)
        await expect(readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'other.md'), 'utf8')).toBe('Alice bytes sibling')
        delete process.env.RERUN_FILE_DELETE_CRASH
        expect((await listing()).status).toBe(200)
        expect(await readdir(join(workspace('engine-alice'), 'docs'))).toEqual(expect.arrayContaining(['other.md']))
        expect((await readdir(join(workspace('engine-alice'), 'docs'))).some(name => name.startsWith('.rerun-delete-'))).toBe(false)
        await closeDesktopDatabase(root)
        expect(await readFile(join(workspace('engine-bob'), 'docs', 'notes.md'), 'utf8')).toBe('Bob bytes')
    })

    test('a file that arrives before the exclusive rename is kept and the previous bytes stay under the test hold name', async () => {
        hooks.beforeMove = async args => {
            if (args[4] !== 'notes.md' || !String(args[7]).startsWith('.rerun-delete-')) return
            hooks.beforeMove = undefined
            const notes = join(workspace('engine-alice'), 'docs', 'notes.md')
            await writeFile(notes + '.hold', await readFile(notes))
            await rm(notes)
            await writeFile(notes, 'Newer occupant')
        }
        expect((await remove('docs/notes.md')).status).toBe(409)
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md'), 'utf8')).toBe('Newer occupant')
        expect(await readFile(join(workspace('engine-alice'), 'docs', 'notes.md.hold'), 'utf8')).toBe('Alice bytes')
        expect((await readdir(join(workspace('engine-alice'), 'docs'))).filter(name => name.startsWith('.rerun-delete-'))).toEqual([])
    })
})
