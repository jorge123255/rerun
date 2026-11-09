import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'
import { renameSharedFile } from './shared-workspace-files.js'

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

describe('shared file rename', () => {
    it('renames a nested file and a case-only name without changing its bytes or leaving stages', async () => {
        const bytes = Buffer.from([0, 255, 1, 2, 3])
        await writeFile(join(shared, 'nested', 'brief.bin'), bytes)
        expect(await renameSharedFile(shared, 'nested/brief.bin', 'plan.bin')).toEqual({ path: 'nested/plan.bin', name: 'plan.bin' })
        await expect(readFile(join(shared, 'nested', 'brief.bin'))).rejects.toThrow()
        expect(await readFile(join(shared, 'nested', 'plan.bin'))).toEqual(bytes)
        expect(await renameSharedFile(shared, 'nested/plan.bin', 'PLAN.bin')).toEqual({ path: 'nested/PLAN.bin', name: 'PLAN.bin' })
        expect(await readFile(join(shared, 'nested', 'PLAN.bin'))).toEqual(bytes)
        expect((await readdir(join(shared, 'nested'))).filter(name => name.startsWith('rename-recovery-'))).toEqual([])
    })

    it('refuses collisions, folders, links, and out-of-root paths while preserving every file', async () => {
        await writeFile(join(shared, 'nested', 'brief.md'), 'source')
        await writeFile(join(shared, 'nested', 'taken.md'), 'destination')
        await expect(renameSharedFile(shared, 'nested/brief.md', 'taken.md')).rejects.toThrow('existing file was kept')
        await expect(renameSharedFile(shared, '../outside.md', 'new.md')).rejects.toThrow('outside the shared folder')
        await expect(renameSharedFile(shared, 'nested/brief.md', '../new.md')).rejects.toThrow('file name')
        await expect(renameSharedFile(shared, 'nested', 'other')).rejects.toThrow('Choose a file')
        await link(join(shared, 'nested', 'brief.md'), join(shared, 'nested', 'linked.md'))
        await expect(renameSharedFile(shared, 'nested/linked.md', 'other.md')).rejects.toThrow('linked elsewhere')
        await symlink(join(shared, 'nested', 'brief.md'), join(shared, 'nested', 'symlink.md'))
        await expect(renameSharedFile(shared, 'nested/symlink.md', 'other.md')).rejects.toThrow('symlink')
        expect(await readFile(join(shared, 'nested', 'brief.md'), 'utf8')).toBe('source')
        expect(await readFile(join(shared, 'nested', 'taken.md'), 'utf8')).toBe('destination')
    })

    it('leaves the source when a destination arrives before the exclusive move', async () => {
        await writeFile(join(shared, 'same.md'), 'ours')
        let checks = 0
        await expect(renameSharedFile(shared, 'same.md', 'taken.md', {
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
