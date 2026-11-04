import { link, open, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
    afterBackupRead: undefined as undefined | (() => Promise<void>),
    beforePublication: undefined as undefined | (() => Promise<void>),
    beforeRename: undefined as undefined | (() => Promise<void>),
    beforeBackupUnlink: undefined as undefined | ((target: string) => Promise<void>),
}))
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    return { ...fs,
        link: async (...args: Parameters<typeof fs.link>) => {
            if (String(args[0]).includes('/.rerun-edit-') && hooks.beforePublication) {
                const hook = hooks.beforePublication
                hooks.beforePublication = undefined
                await hook()
            }
            return fs.link(...args)
        },
        open: async (...args: Parameters<typeof fs.open>) => {
            if ((Number(args[1] ?? 0) & 3) === 0) await hooks.beforeReadOpen?.(String(args[0]))
            const handle = await fs.open(...args)
            if ((Number(args[1] ?? 0) & 3) === 0 && String(args[0]).includes('/.rerun-backup-') && hooks.afterBackupRead) {
                const hook = hooks.afterBackupRead
                hooks.afterBackupRead = undefined
                const close = handle.close.bind(handle)
                return Object.assign(handle, { close: async () => { await close(); await hook() } })
            }
            return hooks.wrapWrite && (Number(args[1] ?? 0) & 3) !== 0 ? hooks.wrapWrite(String(args[0]), handle) : handle
        },
        rename: async (...args: Parameters<typeof fs.rename>) => {
            await hooks.beforeRename?.()
            if (String(args[0]).includes('/.rerun-backup-') && hooks.beforeBackupUnlink) {
                const hook = hooks.beforeBackupUnlink
                hooks.beforeBackupUnlink = undefined
                await hook(String(args[0]))
            }
            return fs.rename(...args)
        },
    }
})

const originalEnv = { ...process.env }
const token = 'f'.repeat(48)
const origin = 'http://127.0.0.1:3190'
let root: string, alice: string
const workspace = (engineId: string) => join(root, 'workspaces', '1', 'engine', 'agents', engineId, 'workspace')
const put = (id: string, body: unknown) => save(new Request(`${origin}/api/desktop/agents/${id}/files/content`, { method: 'PUT',
    headers: { host: '127.0.0.1:3190', origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
{ params: Promise.resolve({ agentId: id }) })
const preview = async (id: string, path: string) => (await read(new Request(`${origin}/api/desktop/agents/${id}/files/read?path=${encodeURIComponent(path)}`,
    { headers: { host: '127.0.0.1:3190', cookie: `rerun-desktop-session=${token}` } }), { params: Promise.resolve({ agentId: id }) })).json()

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-files-edit-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'edit', buildId: 'edit-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    for (const [id, text] of [['engine-alice', '# Alice notes'], ['engine-bob', '# Bob notes']]) {
        await mkdir(join(workspace(id), 'docs'), { recursive: true })
        await writeFile(join(workspace(id), 'docs', 'notes.md'), text)
    }
})
afterEach(async () => {
    hooks.beforePublication = undefined
    hooks.beforeReadOpen = undefined
    hooks.afterBackupRead = undefined
    hooks.wrapWrite = undefined
    hooks.beforeRename = undefined
    hooks.beforeBackupUnlink = undefined
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})


test('an owner folder moved immediately before link publication cannot publish into the sibling', async () => {
    const path = 'docs/notes.md', prev = await preview(alice,path)
    const folder=join(workspace('engine-alice'),'docs'), moved=join(workspace('engine-bob'),'formerly-alice')
    hooks.beforePublication=async()=>{ await rename(folder,moved); await mkdir(folder) }
    const response=await put(alice,{path,content:'ALICE PRIVATE DRAFT',baseHash:prev.hash})
    const text=await readFile(join(moved,'notes.md'),'utf8').catch(()=>null)
    console.log('MOVE_AT_PUBLICATION',response.status,text)
    expect(response.status).not.toBe(200)
    expect(text).not.toBe('ALICE PRIVATE DRAFT')
})
test('an external writer on its existing handle wins at publication', async () => {
    const path='docs/notes.md', full=join(workspace('engine-alice'),path), prev=await preview(alice,path)
    const handle=await open(full,'r+')
    try {
        hooks.beforePublication=async()=>{ await handle.truncate(0); await handle.write('NEW EXTERNAL AUTHOR TEXT',0,'utf8'); await handle.sync() }
        const response=await put(alice,{path,content:'STALE DRAFT',baseHash:prev.hash})
        const body=await response.json()
        const text=await readFile(full,'utf8')
        console.log('HANDLE_AT_PUBLICATION',response.status,text)
        expect(response.status).toBe(409)
        expect(text).toBe('NEW EXTERNAL AUTHOR TEXT')
        expect(body.recovery).toMatchObject({ draft: expect.any(String), external: expect.any(String) })
        expect(await readFile(join(workspace('engine-alice'), body.recovery.draft), 'utf8')).toBe('STALE DRAFT')
        expect(await readFile(join(workspace('engine-alice'), body.recovery.external), 'utf8')).toBe('NEW EXTERNAL AUTHOR TEXT')
    } finally {await handle.close()}
})
test('a losing publication leaves no hidden backup of the original visible in Files',async()=>{
    const path='docs/notes.md', full=join(workspace('engine-alice'),path), prev=await preview(alice,path)
    hooks.beforePublication=async()=>{ await writeFile(full,'COMPETING WINNER') }
    const response=await put(alice,{path,content:'loser',baseHash:prev.hash})
    const names=await readdir(join(workspace('engine-alice'),'docs'))
    console.log('BACKUP_AFTER_CONFLICT',response.status,names)
    expect(await readFile(full,'utf8')).toBe('COMPETING WINNER')
    expect(names).toEqual(['notes.md'])
})
test('a moved folder cannot disclose sibling file text through a conflict response',async()=>{
    const path='docs/notes.md', prev=await preview(alice,path)
    const original=join(workspace('engine-alice'),'docs'), moved=join(workspace('engine-bob'),'formerly-alice')
    hooks.beforeReadOpen=async target=>{
        if(!target.endsWith('/notes.md')) return
        hooks.beforeReadOpen=undefined
        await rename(original,moved); await mkdir(original)
        await writeFile(join(moved,'notes.md'),'BOB PRIVATE CONFLICT TEXT')
    }
    const response=await put(alice,{path,content:'older edit',baseHash:prev.hash})
    const body=await response.json()
    console.log('CONFLICT_LEAK',response.status,body.current?.content)
    expect(body.current?.content).not.toBe('BOB PRIVATE CONFLICT TEXT')
})

test('an open writer after the final backup comparison keeps both versions recoverable', async () => {
    const path = 'docs/notes.md', full = join(workspace('engine-alice'), path), prev = await preview(alice, path)
    const handle = await open(full, 'r+')
    try {
        hooks.afterBackupRead = async () => {
            hooks.afterBackupRead = async () => {
                await handle.truncate(0)
                await handle.write('EXTERNAL AFTER FINAL CHECK', 0, 'utf8')
                await handle.sync()
            }
        }
        const response = await put(alice, { path, content: 'EDITOR DRAFT', baseHash: prev.hash })
        const body = await response.json()
        expect(response.status).toBe(409)
        expect(body.current.content).toBe('EXTERNAL AFTER FINAL CHECK')
        expect(body.recovery).toMatchObject({ draft: expect.any(String), external: expect.any(String) })
        expect(await readFile(full, 'utf8')).toBe('EXTERNAL AFTER FINAL CHECK')
        expect(await readFile(join(workspace('engine-alice'), body.recovery.draft), 'utf8')).toBe('EDITOR DRAFT')
        expect(await readFile(join(workspace('engine-alice'), body.recovery.external), 'utf8')).toBe('EXTERNAL AFTER FINAL CHECK')
    } finally { await handle.close() }
})

test('a different inode arriving at the backup path is not unlinked', async () => {
    const path = 'docs/notes.md', prev = await preview(alice, path)
    let replacement = ''
    hooks.beforeBackupUnlink = async target => {
        replacement = target
        await rm(target)
        await writeFile(target, 'DIFFERENT FILE AT BACKUP PATH')
    }
    const response = await put(alice, { path, content: 'EDITOR DRAFT', baseHash: prev.hash })
    expect(response.status).toBe(409)
    expect(replacement).not.toBe('')
    expect(await readFile(replacement, 'utf8')).toBe('DIFFERENT FILE AT BACKUP PATH')
})

test('rollback does not unlink a different inode at the backup path', async () => {
    const path = 'docs/notes.md', full = join(workspace('engine-alice'), path), prev = await preview(alice, path)
    let replacement = ''
    hooks.beforePublication = async () => { await writeFile(full, 'COMPETING WINNER') }
    hooks.beforeBackupUnlink = async target => {
        replacement = target
        await rm(target)
        await writeFile(target, 'DIFFERENT FILE DURING ROLLBACK')
    }
    const response = await put(alice, { path, content: 'EDITOR DRAFT', baseHash: prev.hash })
    expect(response.status).toBe(409)
    expect(replacement).not.toBe('')
    expect(await readFile(replacement, 'utf8')).toBe('DIFFERENT FILE DURING ROLLBACK')
})

test('crash recovery preserves a held displaced inode and reports both versions on reopen', async () => {
    const docs = join(workspace('engine-alice'), 'docs'), full = join(docs, 'notes.md')
    const temp = join(docs, '.rerun-edit-crash'), backup = join(docs, '.rerun-backup-crash')
    await rename(full, backup)
    await writeFile(temp, 'EDITOR DRAFT AFTER CRASH')
    await link(temp, full)
    const handle = await open(backup, 'r+')
    try {
        await handle.truncate(0)
        await handle.write('EXTERNAL BEFORE CRASH', 0, 'utf8')
        await handle.sync()
        await writeFile(join(docs, '.rerun-publish-crash.json'), JSON.stringify({
            v: 1, final: 'notes.md', temp: '.rerun-edit-crash', backup: '.rerun-backup-crash', phase: 'linked', baseHash: hashText('# Alice notes'),
        }))
        const response = await read(new Request(`${origin}/api/desktop/agents/${alice}/files/read?path=docs%2Fnotes.md`,
            { headers: { host: '127.0.0.1:3190', cookie: `rerun-desktop-session=${token}` } }), { params: Promise.resolve({ agentId: alice }) })
        const body = await response.json()
        expect(response.status).toBe(409)
        expect(body.current.content).toBe('EXTERNAL BEFORE CRASH')
        expect(body.recovery).toMatchObject({ draft: expect.any(String), external: expect.any(String) })
        expect(await readFile(full, 'utf8')).toBe('EXTERNAL BEFORE CRASH')
        expect(await readFile(join(workspace('engine-alice'), body.recovery.draft), 'utf8')).toBe('EDITOR DRAFT AFTER CRASH')
        expect(await readFile(join(workspace('engine-alice'), body.recovery.external), 'utf8')).toBe('EXTERNAL BEFORE CRASH')
    } finally { await handle.close() }
})
