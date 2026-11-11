import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import { createSharedDocument, editSharedDocument, searchSharedDocuments } from './fs.js'
import { sharedReadGranted, sharedWriteGranted } from './grants.js'
import { acquireSkillLease } from '../skill-publication-native.js'
import * as workspaceFiles from '../shared-workspace-files.js'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let root = ''
let shared = ''
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const priorHelper = process.env.RERUN_DESKTOP_RENAME_HELPER

beforeAll(async () => {
    helper = await prepareSkillHelperFixture()
    process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-shared-mutations-')))
    shared = join(root, 'workspaces', '1', 'engine', 'shared')
    await mkdir(shared, { recursive: true })
})
afterAll(async () => {
    if (priorHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER
    else process.env.RERUN_DESKTOP_RENAME_HELPER = priorHelper
    await helper?.close()
    if (root) await rm(root, { recursive: true, force: true })
})

test('a read grant is not a write grant', () => {
    const read = { enabled: true, tools: { shared: true, desktopToolGrants: { sharedFilesRead: true, privateFileWrite: true } } }
    expect(sharedReadGranted(read)).toBe(true)
    expect(sharedWriteGranted(read)).toBe(false)
    expect(sharedReadGranted({ enabled: true, tools: { shared: true, desktopToolGrants: { sharedFilesWrite: true } } })).toBe(false)
    expect(sharedWriteGranted({ enabled: true, tools: { shared: false, desktopToolGrants: { sharedFilesWrite: true } } })).toBe(false)
})

test('both coworkers see the shared note and neither search sees a private file', async () => {
    const privateDir = join(root, 'workspaces', '1', 'engine', 'coworkers', 'alpha')
    await mkdir(join(shared, 'node_modules'), { recursive: true })
    await mkdir(privateDir, { recursive: true })
    await writeFile(join(shared, 'note.txt'), 'shared hello')
    await writeFile(join(shared, 'node_modules', 'pkg.txt'), 'hidden sentinel')
    await writeFile(join(privateDir, 'secret.md'), 'PRIVATE-SENTINEL')
    await symlink(join(privateDir, 'secret.md'), join(shared, 'link.txt'))
    const first = await searchSharedDocuments(shared, { pattern: 'hello|SENTINEL|hidden', maxResults: 20 })
    const second = await searchSharedDocuments(shared, { pattern: 'hello|SENTINEL|hidden', maxResults: 20 })
    expect(first.hits).toEqual(second.hits)
    expect(first.hits.map(hit => hit.text)).toEqual(['shared hello'])
    expect(JSON.stringify(first)).not.toContain('PRIVATE-SENTINEL')
    expect(JSON.stringify(first)).not.toContain('hidden sentinel')
})

test('create does not overwrite, a bad path writes nothing, and stop writes nothing', async () => {
    const created = await createSharedDocument(shared, 'fresh.txt', 'first')
    expect(created.status).toBe('saved')
    const again = await createSharedDocument(shared, 'fresh.txt', 'second')
    expect(again).toMatchObject({ status: 'refused', code: 'exists' })
    expect(await readFile(join(shared, 'fresh.txt'), 'utf8')).toBe('first')
    await expect(createSharedDocument(shared, '../outside.txt', 'no')).rejects.toThrow(/outside/)
    expect(await readFile(join(root, 'workspaces', '1', 'engine', 'outside.txt')).catch(() => null)).toBeNull()
    await expect(createSharedDocument(shared, 'stopped.txt', 'no', { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(await readFile(join(shared, 'stopped.txt')).catch(() => null)).toBeNull()
})

test('edit keeps the file on a hash conflict and preserves newlines', async () => {
    const original = Buffer.from('keep\r\nme', 'utf8')
    await writeFile(join(shared, 'edit.txt'), original)
    const conflict = await editSharedDocument(shared, { path: 'edit.txt', oldString: 'keep', newString: 'lose', expectedBytes: 1, expectedSha256: 'ab'.repeat(32) })
    expect(conflict).toMatchObject({ status: 'refused', code: 'conflict' })
    expect(await readFile(join(shared, 'edit.txt'))).toEqual(original)
    const saved = await editSharedDocument(shared, { path: 'edit.txt', oldString: 'me', newString: 'us', expectedBytes: original.length, expectedSha256: hash(original) })
    expect(saved.status).toBe('saved')
    expect(await readFile(join(shared, 'edit.txt'))).toEqual(Buffer.from('keep\r\nus', 'utf8'))
    const linked = await editSharedDocument(shared, { path: 'link.txt', oldString: 'PRIVATE-SENTINEL', newString: 'changed', expectedBytes: 16, expectedSha256: 'cd'.repeat(32) })
    expect(linked).toMatchObject({ status: 'refused', code: 'symlink' })
    expect(await readFile(join(root, 'workspaces', '1', 'engine', 'coworkers', 'alpha', 'secret.md'), 'utf8')).toBe('PRIVATE-SENTINEL')
})

test('edit replacement is literal, preserves the BOM, and keeps complete previous bytes before publication', async () => {
    const original = Buffer.from('\ufeffkeep me\r\n')
    await writeFile(join(shared,'literal.txt'),original)
    const before = new Set(await readdir(shared))
    const result = await editSharedDocument(shared,{ path: 'literal.txt',oldString: 'me',newString: '$& $` $\'',expectedBytes: original.length,expectedSha256: hash(original) })
    expect(result.status).toBe('saved')
    expect(await readFile(join(shared,'literal.txt'),'utf8')).toBe('\ufeffkeep $& $` $\'\r\n')
    const copies = (await readdir(shared)).filter(name => !before.has(name) && name.startsWith('shared-edit-recovery-'))
    expect(copies).toHaveLength(1)
    expect(await readFile(join(shared,copies[0]!))).toEqual(original)
    expect(result.message).toContain(copies[0])
})

test('concurrent distinct edits with the same fingerprint serialize the full shorter/longer publication and retain the original recovery bytes', async () => {
    const original = Buffer.from('before: TARGET :after\r\n')
    await writeFile(join(shared,'concurrent.txt'),original)
    const before = new Set(await readdir(shared))
    const base = { path: 'concurrent.txt',oldString: 'TARGET',expectedBytes: original.length,expectedSha256: hash(original) }
    const outcomes = await Promise.all([
        editSharedDocument(shared,{ ...base,newString: 'x' }),
        editSharedDocument(shared,{ ...base,newString: 'a substantially longer replacement' }),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'saved')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'refused' && outcome.code === 'conflict')).toHaveLength(1)
    const final = await readFile(join(shared,'concurrent.txt'))
    const expected = [Buffer.from('before: x :after\r\n'),Buffer.from('before: a substantially longer replacement :after\r\n')]
    expect(expected.some(bytes => bytes.equals(final))).toBe(true)
    const copies = (await readdir(shared)).filter(name => !before.has(name) && name.startsWith('shared-edit-recovery-'))
    expect(copies).toHaveLength(1)
    expect(await readFile(join(shared,copies[0]!))).toEqual(original)
    const saved = outcomes.find(outcome => outcome.status === 'saved')!
    expect(saved.bytes).toBe(final.length)
    expect(saved.sha256).toBe(hash(final))
})

test('holds the shared native publication lease after recovery and before the edit writes', async () => {
    const original = Buffer.from('keep the original\n')
    const path = 'publication-lease.txt'
    await writeFile(join(shared, path), original)
    let recoveryPublished = false
    let entered!: () => void, resume!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const proceed = new Promise<void>(resolve => { resume = resolve })
    const importText = workspaceFiles.importSharedText
    const recovery = vi.spyOn(workspaceFiles, 'importSharedText').mockImplementationOnce(async (...args) => {
        const result = await importText(...args)
        recoveryPublished = true
        return result
    })
    const edit = editSharedDocument(shared, {
        path, oldString: 'original', newString: 'updated file', expectedBytes: original.length, expectedSha256: hash(original),
    }, { async beforeCommit() {
        if (recoveryPublished) { entered(); await proceed }
    } })
    try {
        await Promise.race([ready, edit.then(() => { throw new Error('Edit completed before its final authority check') })])
        const stop = AbortSignal.timeout(450)
        const directory = await lstat(shared, { bigint: true })
        const competing = await acquireSkillLease(shared, directory, stop).then(async lease => {
            await lease.release()
            return 'acquired'
        }, error => {
            expect(error).toBe(stop.reason)
            return 'blocked'
        })
        expect(competing).toBe('blocked')
        expect(await readFile(join(shared, path))).toEqual(original)
    } finally {
        resume()
        recovery.mockRestore()
        await edit
    }
    expect(await edit).toMatchObject({ status: 'saved', committed: true })
    expect(await workspaceFiles.renameSharedFile(shared, path, 'publication-renamed.txt')).toMatchObject({ name: 'publication-renamed.txt' })
    expect(await readFile(join(shared, 'publication-renamed.txt'), 'utf8')).toBe('keep the updated file\n')
})

test('refuses to edit an inode renamed between the recovery import and final publication', async () => {
    const original = Buffer.from('before edit\n')
    const path = 'before-lock.txt', renamed = 'renamed-before-lock.txt'
    await writeFile(join(shared, path), original)
    const importText = workspaceFiles.importSharedText
    const recovery = vi.spyOn(workspaceFiles, 'importSharedText').mockImplementationOnce(async (...args) => {
        const result = await importText(...args)
        await workspaceFiles.renameSharedFile(shared, path, renamed)
        return result
    })
    try {
        const result = await editSharedDocument(shared, {
            path, oldString: 'before', newString: 'after', expectedBytes: original.length, expectedSha256: hash(original),
        })
        expect(result).toMatchObject({ status: 'refused', code: 'conflict', committed: false })
        await expect(lstat(join(shared, path))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(shared, renamed))).toEqual(original)
    } finally { recovery.mockRestore() }
})
