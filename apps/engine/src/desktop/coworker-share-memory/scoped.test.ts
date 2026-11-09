import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, readdir, link, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test as baseTest } from 'vitest'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.ts'
import { captureScopedCoworkerMemories, restoreScopedCoworkerMemories } from './scoped.ts'
import { renderMemoryMarkdown, serializeMemoryNote } from './serialize.ts'
import { captureDesktopCoworkerShareMemory } from './capture.ts'

let directory = ''
// The production adapter intentionally uses Darwin inode anchors, not process-global paths.
const test = baseTest.skipIf(process.platform !== 'darwin')
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const oldHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { if (process.platform !== 'darwin') return; helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => { if (process.platform !== 'darwin') return; if (oldHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = oldHelper; await helper.close() })
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(),'share-memory-scoped-'))) })
afterEach(async () => { await rm(directory,{ recursive: true, force: true }) })
const notes = ['one','two'].map(id => serializeMemoryNote({ id, kind: 'note', tags: ['unicode'], createdAt: '2026-01-02T03:04:05Z', content: `Keep ${id} — 世界.` }))
const bytes = (index: number) => Buffer.from(renderMemoryMarkdown(notes[index]!))
const current = async () => {}
const capture = () => captureScopedCoworkerMemories({ agentRoot: directory, workspaceId: 7, agentId: 'source', requestId: 'capture', assertCurrent: current })
async function pkg() {
    const result = await captureDesktopCoworkerShareMemory({ workspaceId: 7, agentId: 'source', listOwnedNotes: async () => notes },{ requestId: 'capture', includeMemories: true })
    if ('unavailable' in result) throw new Error(result.reason)
    return result
}

test('captures only canonical active notes, preserving Unicode, identities and exact rendered sizes', async () => {
    await mkdir(join(directory,'memory','archive'),{ recursive: true })
    await writeFile(join(directory,'memory','one.md'),bytes(0))
    for (const path of ['recall.md','.RERUN-receipt.md','index.sqlite','archive/two.md']) await writeFile(join(directory,'memory',path),'Excluded internal content')
    const result = await capture()
    expect(result.notes).toEqual([notes[0]])
    expect(result.contents).toEqual({ count: 1, bytes: bytes(0).length })
    expect(await readdir(join(directory,'memory'))).not.toContain('.rerun-share-memories.json')
})

test.each(['symbolic','hard'] as const)('refuses a %s alias instead of copying another file', async kind => {
    await mkdir(join(directory,'memory'))
    const other = join(directory,'other.md')
    await writeFile(other,bytes(0))
    if (kind === 'symbolic') await symlink(other,join(directory,'memory','one.md'))
    else await link(other,join(directory,'memory','one.md'))
    await expect(capture()).rejects.toThrow()
})

test('malformed/oversized notes and changed owner fail closed without a partial capture', async () => {
    await mkdir(join(directory,'memory'))
    await writeFile(join(directory,'memory','one.md'),bytes(0))
    await writeFile(join(directory,'memory','two.md'),Buffer.alloc(24_577,65))
    await expect(capture()).rejects.toThrow()
    await writeFile(join(directory,'memory','two.md'),'Missing canonical identity')
    await expect(capture()).rejects.toThrow()
    await expect(captureScopedCoworkerMemories({ agentRoot: directory, workspaceId: 7, agentId: 'other', requestId: 'stale', assertCurrent: async () => { throw new Error('Owner changed') } })).rejects.toThrow('Owner changed')
})

test('interrupted restore resumes only its durable reservation and exact note bytes, never a new attempt', async () => {
    const input = { agentRoot: directory, workspaceId: 7, destinationAgentId: 'fresh', importReceiptId: 'exact-receipt', pkg: await pkg(), assertFreshImport: current }
    let interrupted = false
    await expect(restoreScopedCoworkerMemories({ ...input, assertFreshImport: async () => {
        if (!interrupted && (await readdir(join(directory,'memory')).catch(() => [])).includes('one.md')) { interrupted = true; throw new Error('Stop / lost acknowledgement') }
    } })).rejects.toThrow('Stop / lost acknowledgement')
    expect(await readFile(join(directory,'memory','one.md'))).toEqual(bytes(0))
    await expect(restoreScopedCoworkerMemories({ ...input, importReceiptId: 'different-receipt' })).rejects.toThrow()
    // A new authority instance after restart needs no in-memory seen map.
    expect(await restoreScopedCoworkerMemories(input)).toMatchObject({ status: 'installed', installedCount: 1, reusedCount: 1 })
    expect(await restoreScopedCoworkerMemories(input)).toMatchObject({ status: 'reused', installedCount: 0, reusedCount: 2 })
    expect(await readFile(join(directory,'memory','two.md'))).toEqual(bytes(1))
})

test('never adopts foreign notes or overwrites an altered partial import', async () => {
    const input = { agentRoot: directory, workspaceId: 7, destinationAgentId: 'fresh', importReceiptId: 'exact-receipt', pkg: await pkg(), assertFreshImport: current }
    await mkdir(join(directory,'memory'))
    await writeFile(join(directory,'memory','one.md'),bytes(0))
    await expect(restoreScopedCoworkerMemories(input)).rejects.toThrow()
    await rm(join(directory,'memory','one.md'))
    await restoreScopedCoworkerMemories(input)
    await writeFile(join(directory,'memory','one.md'),'Altered after import')
    await expect(restoreScopedCoworkerMemories(input)).rejects.toThrow()
    expect(await readFile(join(directory,'memory','one.md'),'utf8')).toBe('Altered after import')
})
