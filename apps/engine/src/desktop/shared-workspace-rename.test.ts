import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'
import { listSharedDirectory, renameSharedEntry } from './shared-workspace-files.js'

let app = ''
let shared = ''
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const priorHelper = process.env.RERUN_DESKTOP_RENAME_HELPER

beforeAll(async () => {
    helper = await prepareSkillHelperFixture()
    process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path
})
beforeEach(async () => {
    app = await realpath(await mkdtemp(join(tmpdir(), 'rerun-shared-rename-')))
    shared = join(app, 'shared')
    await mkdir(join(shared, 'nested'), { recursive: true })
})
afterEach(async () => { await rm(app, { recursive: true, force: true }) })
afterAll(async () => {
    if (priorHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = priorHelper
    await helper?.close()
})

async function revision(name: string, parent = '') {
    const listing = await listSharedDirectory(shared, parent, { deleteMetadata: true })
    return listing.entries.find(entry => entry.name === name)!.deleteRevision!
}

describe('shared file and folder rename', () => {
    it('renames a selected non-empty folder and a case-only name while preserving its contents', async () => {
        await mkdir(join(shared, 'nested', 'child'))
        const bytes = Buffer.from([0, 255, 13, 10])
        await writeFile(join(shared, 'nested', 'child', 'report.bin'), bytes)
        const selected = await revision('nested')
        expect(await renameSharedEntry(shared, 'nested', 'Archive', { revision: selected })).toEqual({ path: 'Archive', name: 'Archive' })
        expect(await renameSharedEntry(shared, 'Archive', 'ARCHIVE', { revision: await revision('Archive') })).toEqual({ path: 'ARCHIVE', name: 'ARCHIVE' })
        expect(await readFile(join(shared, 'ARCHIVE', 'child', 'report.bin'))).toEqual(bytes)
        expect((await readdir(shared)).filter(name => !name.startsWith('.'))).toEqual(['ARCHIVE'])
    })

    it('preserves a replaced directory and refuses to overwrite a sibling folder', async () => {
        await writeFile(join(shared, 'nested', 'note.md'), 'original')
        const selected = await revision('nested')
        await rename(join(shared, 'nested'), join(shared, 'original'))
        await mkdir(join(shared, 'nested'))
        await writeFile(join(shared, 'nested', 'note.md'), 'replacement')
        await expect(renameSharedEntry(shared, 'nested', 'renamed', { revision: selected })).rejects.toMatchObject({ status: 409 })
        await expect(renameSharedEntry(shared, 'nested', 'original', { revision: await revision('nested') })).rejects.toThrow('existing file was kept')
        expect(await readFile(join(shared, 'nested', 'note.md'), 'utf8')).toBe('replacement')
        expect(await readFile(join(shared, 'original', 'note.md'), 'utf8')).toBe('original')
    })

    it('renames a nested file and a case-only name without changing its bytes or leaving stages', async () => {
        const bytes = Buffer.from([0, 255, 1, 2, 3])
        await writeFile(join(shared, 'nested', 'brief.bin'), bytes)
        expect(await renameSharedEntry(shared, 'nested/brief.bin', 'plan.bin')).toEqual({ path: 'nested/plan.bin', name: 'plan.bin' })
        await expect(readFile(join(shared, 'nested', 'brief.bin'))).rejects.toThrow()
        expect(await readFile(join(shared, 'nested', 'plan.bin'))).toEqual(bytes)
        expect(await renameSharedEntry(shared, 'nested/plan.bin', 'PLAN.bin')).toEqual({ path: 'nested/PLAN.bin', name: 'PLAN.bin' })
        expect(await readFile(join(shared, 'nested', 'PLAN.bin'))).toEqual(bytes)
        expect((await readdir(join(shared, 'nested'))).filter(name => name.startsWith('rename-recovery-'))).toEqual([])
    })

    it('refuses collisions, folders, links, and out-of-root paths while preserving every file', async () => {
        await writeFile(join(shared, 'nested', 'brief.md'), 'source')
        await writeFile(join(shared, 'nested', 'taken.md'), 'destination')
        await expect(renameSharedEntry(shared, 'nested/brief.md', 'taken.md')).rejects.toThrow('existing file was kept')
        await expect(renameSharedEntry(shared, '../outside.md', 'new.md')).rejects.toThrow('outside the shared folder')
        await expect(renameSharedEntry(shared, 'nested/brief.md', '../new.md')).rejects.toThrow('file name')
        await expect(renameSharedEntry(shared, 'nested', 'other')).rejects.toThrow('Choose a file')
        await link(join(shared, 'nested', 'brief.md'), join(shared, 'nested', 'linked.md'))
        await expect(renameSharedEntry(shared, 'nested/linked.md', 'other.md')).rejects.toThrow('linked elsewhere')
        await symlink(join(shared, 'nested', 'brief.md'), join(shared, 'nested', 'symlink.md'))
        await expect(renameSharedEntry(shared, 'nested/symlink.md', 'other.md')).rejects.toThrow('symlink')
        expect(await readFile(join(shared, 'nested', 'brief.md'), 'utf8')).toBe('source')
        expect(await readFile(join(shared, 'nested', 'taken.md'), 'utf8')).toBe('destination')
    })

    it('leaves the source when a destination arrives before the exclusive move', async () => {
        await writeFile(join(shared, 'same.md'), 'ours')
        let checks = 0
        await expect(renameSharedEntry(shared, 'same.md', 'taken.md', {
            beforeCommit: async () => {
                if (++checks === 3) {
                    await writeFile(join(shared, 'taken.md'), 'theirs', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
                }
            },
        })).rejects.toThrow('existing file was kept')
        expect(await readFile(join(shared, 'same.md'), 'utf8')).toBe('ours')
        expect(await readFile(join(shared, 'taken.md'), 'utf8')).toBe('theirs')
        expect((await readdir(shared)).filter(name => name.startsWith('rename-recovery-'))).toEqual([])
    })
})
