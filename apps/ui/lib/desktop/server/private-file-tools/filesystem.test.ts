import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent } from '../store'
import { listCoworkerFiles, readPrivateCoworkerFile, saveCoworkerFile } from '../coworker-files'
import { withRosterWrite } from '../roster-writes'
import type { DesktopRuntime } from '../runtime'
import { privateFilePublisher, privateFileReceiptSchema, type PrivateFileCall } from './publication'
import { hashText } from '@/lib/files/editable'

vi.mock('server-only', () => ({}))
let root: string, owner: string, workspace: string, sibling: string, runtime: DesktopRuntime
let db: Awaited<ReturnType<typeof openDesktopDatabase>>
const signal = () => new AbortController().signal
const call = (toolCallId = 'edit'): PrivateFileCall => ({engineAgentId: 'private-owner', sessionId: 'session', runId: 'run', toolCallId,
    tool: 'fs_edit', arguments: {path: 'docs/note.md', oldString: 'old', newString: 'new'}})
const authorize = async () => ({owner, runtime})

beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-private-tool-')))
    runtime = {protocolVersion: 1, launchNonce: 'private-files', buildId: 'fixture', workspaceId: 1, dataRoot: root,
        app: {origin: 'http://127.0.0.1:3190', sessionToken: 'x'.repeat(48)}, engine: {origin: 'http://127.0.0.1:9', apiKey: 'unused'}}
    db = await openDesktopDatabase(root)
    await db.executeMultiple(privateFileReceiptSchema)
    owner = (await createDesktopAgent(db, {engineAgentId: 'private-owner', name: 'Private owner'})).id
    workspace = join(root, 'workspaces', '1', 'engine', 'agents', 'private-owner', 'workspace')
    sibling = join(root, 'workspaces', '1', 'engine', 'agents', 'private-sibling', 'workspace')
    await mkdir(join(workspace, 'docs'), {recursive: true})
    await mkdir(sibling, {recursive: true})
    await writeFile(join(workspace, 'docs/note.md'), 'old text')
})
afterEach(async () => { await closeDesktopDatabase(root); await rm(root, {recursive: true, force: true}) })

it('refuses a real hardlinked sibling file and leaves both names and bytes untouched', async () => {
    await writeFile(join(sibling, 'secret.md'), 'old private sibling text')
    await link(join(sibling, 'secret.md'), join(workspace, 'docs/linked.md'))
    const request: PrivateFileCall = {...call(), arguments: {path: 'docs/linked.md', oldString: 'old', newString: 'new'}}
    await expect(privateFilePublisher(db, authorize)(request, signal())).rejects.toThrow('singly linked')
    expect(await readFile(join(sibling, 'secret.md'), 'utf8')).toBe('old private sibling text')
    expect(await readFile(join(workspace, 'docs/linked.md'), 'utf8')).toBe('old private sibling text')
    expect((await lstat(join(sibling, 'secret.md'))).nlink).toBe(2)
    expect((await db.execute('SELECT * FROM desktop_private_file_calls')).rows).toEqual([])
})

it('rejects a symlinked private folder even if its target is inside the same workspace', async () => {
    await symlink(join(workspace, 'docs'), join(workspace, 'alias'))
    const request: PrivateFileCall = {...call(), arguments: {path: 'alias/note.md', oldString: 'old', newString: 'new'}}
    await expect(privateFilePublisher(db, authorize)(request, signal())).rejects.toThrow()
    expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('old text')
})

it('refuses a link added after the complete snapshot, without detaching its text', async () => {
    const snapshot = await readPrivateCoworkerFile(runtime, owner, 'docs/note.md', async () => {})
    await link(join(workspace, 'docs/note.md'), join(sibling, 'late.md'))
    await expect(saveCoworkerFile(runtime, owner, 'docs/note.md', 'new text', snapshot.hash, snapshot.identity,
        {existingDirectoryOnly: true, snapshot, beforePublish: async () => {}})).rejects.toThrow('singly linked')
    expect(await readFile(join(sibling, 'late.md'), 'utf8')).toBe('old text')
})

it('refuses a same-inode edit made after its snapshot and preserves the newer text', async () => {
    const snapshot = await readPrivateCoworkerFile(runtime, owner, 'docs/note.md', async () => {})
    await writeFile(join(workspace, 'docs/note.md'), 'someone else wrote this')
    await expect(saveCoworkerFile(runtime, owner, 'docs/note.md', 'new text', snapshot.hash, snapshot.identity,
        {existingDirectoryOnly: true, snapshot, beforePublish: async () => {}})).rejects.toThrow()
    expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('someone else wrote this')
})

it('rechecks the pinned folder after an awaited permission check immediately before rename', async () => {
    const snapshot = await readPrivateCoworkerFile(runtime, owner, 'docs/note.md', async () => {})
    let checks = 0
    const beforePublish = async () => {
        if (++checks !== 3) return
        await rename(join(workspace, 'docs'), join(sibling, 'moved'))
        await mkdir(join(workspace, 'docs'))
        await writeFile(join(workspace, 'docs/note.md'), 'replacement directory winner')
    }
    await expect(saveCoworkerFile(runtime, owner, 'docs/note.md', 'new text', snapshot.hash, snapshot.identity,
        {existingDirectoryOnly: true, snapshot, beforePublish})).rejects.toThrow()
    expect(checks).toBe(3)
    expect(await readFile(join(sibling, 'moved/note.md'), 'utf8')).toBe('old text')
    expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('replacement directory winner')
})

it('publishes once, retains the displaced inode for a late foreign writer, and replays after a new service', async () => {
    const held = await open(join(workspace, 'docs/note.md'), 'r+')
    try {
        const first = await privateFilePublisher(db, authorize)(call(), signal())
        expect(first.status).toBe('saved')
        expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('new text')
        await held.write('foreign writer', 0, 'utf8')
        await held.sync()
        const backups = (await readdir(join(workspace, 'docs'))).filter(name => name.startsWith('.rerun-backup-'))
        expect(backups).toHaveLength(1)
        expect(await readFile(join(workspace, 'docs', backups[0]!), 'utf8')).toBe('foreign writer')
        await listCoworkerFiles(runtime, owner, 'docs', true)
        expect(await readFile(join(workspace, 'docs', backups[0]!), 'utf8')).toBe('foreign writer')
        expect(await privateFilePublisher(db, authorize)(call(), signal())).toEqual(first)
        expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('new text')
    } finally { await held.close() }
})

it('creates only a missing text file in an existing private directory', async () => {
    const publish = privateFilePublisher(db, authorize)
    const request: PrivateFileCall = {...call('create'), tool: 'fs_write', arguments: {path: 'docs/new.md', content: 'complete'}}
    expect((await publish(request, signal())).status).toBe('saved')
    expect(await readFile(join(workspace, 'docs/new.md'), 'utf8')).toBe('complete')
    expect((await publish({...request, toolCallId: 'overwrite', arguments: {path: 'docs/new.md', content: 'replacement'}}, signal())).status).toBe('unknown')
    expect(await readFile(join(workspace, 'docs/new.md'), 'utf8')).toBe('complete')
    expect((await publish({...request, toolCallId: 'missing-folder', arguments: {path: 'missing/new.md', content: 'complete'}}, signal())).status).toBe('unknown')
    await expect(lstat(join(workspace, 'missing'))).rejects.toMatchObject({code: 'ENOENT'})
})

it('does not recover a journal or edit a file when permission is revoked while queued', async () => {
    let release!: () => void, entered!: () => void, enabled = true
    const enteredQueue = new Promise<void>(resolve => { entered = resolve })
    const queued = withRosterWrite(async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
    await enteredQueue
    const auth = vi.fn(async () => { if (!enabled) throw new Error('revoked'); return {owner, runtime} })
    const pending = privateFilePublisher(db, auth)(call(), signal())
    await vi.waitFor(() => expect(auth.mock.calls.length).toBeGreaterThanOrEqual(3))
    enabled = false
    release()
    await queued
    await expect(pending).rejects.toThrow('revoked')
    expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('old text')
    expect((await readdir(join(workspace, 'docs'))).filter(name => name.startsWith('.rerun-'))).toEqual([])
})

it('requires human recovery rather than mutating an interrupted journal during a model read', async () => {
    const journal = join(workspace, 'docs/.rerun-publish-incomplete.json')
    await writeFile(journal, '{"incomplete":true}')
    await expect(privateFilePublisher(db, authorize)(call(), signal())).rejects.toThrow('needs recovery')
    expect(await readFile(journal, 'utf8')).toBe('{"incomplete":true}')
    expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('old text')
})

it.each(['prepared', 'linked'] as const)('human recovery of a tool %s journal keeps both the old inode and proposed bytes', async phase => {
    const folder = join(workspace, 'docs')
    const final = join(folder, 'note.md'), temp = '.rerun-edit-fixture', backup = '.rerun-backup-fixture'
    await writeFile(join(folder, temp), 'new text')
    await rename(final, join(folder, backup))
    await link(join(folder, temp), final)
    await writeFile(join(folder, '.rerun-publish-fixture.json'), JSON.stringify({v: 1, final: 'note.md', temp, backup,
        phase, baseHash: hashText('old text'), retainBackup: true}))
    await listCoworkerFiles(runtime, owner, 'docs', true)
    expect(await readFile(final, 'utf8')).toBe(phase === 'linked' ? 'new text' : 'old text')
    const backups = (await readdir(folder)).filter(name => name.startsWith('.rerun-backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(folder, backups[0]!), 'utf8')).toBe(phase === 'linked' ? 'old text' : 'new text')
    // A later list must not retire the last name merely because no foreign writer is currently open.
    await listCoworkerFiles(runtime, owner, 'docs', true)
    expect(await readFile(join(folder, backups[0]!), 'utf8')).toBe(phase === 'linked' ? 'old text' : 'new text')
})

it('refuses additional edits when retained recovery files reach their aggregate budget', async () => {
    const backup = await open(join(workspace, 'docs/.rerun-backup-budget'), 'w')
    try { await backup.truncate(50 * 1024 * 1024) } finally { await backup.close() }
    expect((await privateFilePublisher(db, authorize)(call(), signal())).status).toBe('unknown')
    expect(await readFile(join(workspace, 'docs/note.md'), 'utf8')).toBe('old text')
    expect((await readdir(join(workspace, 'docs'))).filter(name => name.startsWith('.rerun-publish-'))).toEqual([])
})
