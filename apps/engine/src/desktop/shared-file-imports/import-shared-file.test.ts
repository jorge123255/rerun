import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import { importSharedFile, importSharedText } from '../shared-workspace-files'

let app = ''
let root = ''
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const priorHelper = process.env.RERUN_DESKTOP_RENAME_HELPER

beforeAll(async () => {
    helper = await prepareSkillHelperFixture()
    process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path
})
beforeEach(async () => {
    app = await realpath(await mkdtemp(join(tmpdir(), 'rerun-shared-import-authority-')))
    root = join(app, 'shared')
})
afterEach(async () => { await rm(app, { recursive: true, force: true }) })
afterAll(async () => {
    if (priorHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = priorHelper
    await helper?.close()
})

describe('shared ordinary-file writer', () => {
    it('writes exact binary bytes with create-only names and preserves the existing file on conflict', async () => {
        const bytes = Buffer.from([0, 255, 1, 2, 3])
        expect(await importSharedFile(root, 'nested', 'image.png', bytes)).toEqual({ path: 'nested/image.png', name: 'image.png' })
        expect(await readFile(join(root, 'nested', 'image.png'))).toEqual(bytes)
        await expect(importSharedFile(root, 'nested', 'image.png', Buffer.from('different'))).rejects.toThrow('existing file was kept')
        expect(await readFile(join(root, 'nested', 'image.png'))).toEqual(bytes)
    })

    it('keeps the original text-only authority and enforces per-type byte limits', async () => {
        await expect(importSharedText(root, '', 'note.md', Buffer.from('# shared'))).resolves.toEqual({ path: 'note.md', name: 'note.md' })
        await expect(importSharedFile(root, '', 'large.pdf', Buffer.alloc(5), { maxBytes: 4 })).rejects.toThrow('up to 4 bytes')
        await expect(importSharedFile(root, '', 'run.exe', Buffer.from('no'))).rejects.toThrow('supported shared file')
    })
})
