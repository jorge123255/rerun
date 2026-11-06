import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { DESKTOP_PORTABLE_TEMPLATE_FORMAT, DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION, DESKTOP_PORTABLE_TEMPLATE_LIMITS, DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING, DESKTOP_TEMPLATE_LIMITS, DESKTOP_TEMPLATE_PROSE_WARNING } from '@rerun/contracts'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import { inspectCoworker } from './inspect.ts'
import { isTemplateManifestPath, installManifest, readManifest, sealManifest } from './install.ts'
import { importDesktopPortableTemplate } from './portable-import.ts'
import { readPortableArchive, sealPortableManifest, writePortableArchive } from './portable-package.ts'
import { listTemplateIds } from './store.ts'
import { sha256 } from './hash.ts'

const reserved = ['workspace/.rerun-backup-old','workspace/.rerun-skill-lock','workspace/.rerun/services.json','workspace/docs/.rerun-edit-old','workspace/docs/.rerun-publish-id.json','workspace/docs/.rerun-backup-dir/old.md','workspace/docs/.RERUN-retire-alias']
const ordinary = ['workspace/.notes.md','workspace/docs/.keep','workspace/.user-folder/guide.txt']
const roots: string[] = []
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => { if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper; await helper.close() })
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{ recursive: true,force: true }))) })
async function root() { const value = await realpath(await mkdtemp(join(tmpdir(),'rerun-template-metadata-'))); roots.push(value); return value }

test('the real inspector prunes reserved workspace files and trees before the walk limit while preserving user hidden files and skills', async () => {
    const agentsRoot = await root(), folder = join(agentsRoot,'source')
    const files = ['SOUL.md','INSTALL.md','config.json','skills/user/SKILL.md',...reserved,...ordinary]
    for (const path of files) {
        await mkdir(dirname(join(folder,path)),{ recursive: true })
        const text = path === 'config.json' ? JSON.stringify({ name: 'Source',setup: { required: false } }) : path === 'skills/user/SKILL.md' ? '---\nname: User\ndescription: User notes\n---\nRead the notes.' : reserved.includes(path) ? 'PRIVATE_INTERNAL_BYTES' : 'User content'
        await writeFile(join(folder,path),text)
    }
    // Internal contents must neither become selectable nor exhaust the user-file budget.
    await mkdir(join(folder,'workspace','.rerun-cache'),{ recursive: true })
    for (let index=0; index<30; index++) await writeFile(join(folder,'workspace','.rerun-cache',`${index}.txt`),'PRIVATE_INTERNAL_BYTES')
    const inspected = await inspectCoworker(agentsRoot,randomUUID(),'source',{ includeBinary: true,requireTrustedOwnership: true,skillOwnership: () => 'user',maxWalkEntries: 12 })
    expect(inspected.blocked).toBeNull()
    expect(inspected.soul?.path).toBe('SOUL.md'); expect(inspected.install?.path).toBe('INSTALL.md')
    expect(inspected.selectableFiles.map(file => file.path).sort()).toEqual([...ordinary].sort())
    expect(inspected.selectableSkills.map(skill => skill.slug)).toEqual(['user'])
    expect(inspected.selectableFiles.some(file => file.raw.includes(Buffer.from('PRIVATE_INTERNAL_BYTES')))).toBe(false)
})

test('the canonical path guard refuses reserved segments at any workspace depth and preserves normal hidden user paths', () => {
    for (const path of reserved) expect(isTemplateManifestPath(path),path).toBe(false)
    for (const path of ['SOUL.md','INSTALL.md','config.json','skills/user/SKILL.md',...ordinary]) expect(isTemplateManifestPath(path),path).toBe(true)
})

async function archive(path: string) {
    const config = Buffer.from('{"name":"Portable metadata fixture"}\n'), bytes = Buffer.from('PRIVATE_INTERNAL_BYTES')
    const members = [{ agentKey: 'c00',path: 'config.json',bytes: config,digest: sha256(config) },{ agentKey: 'c00',path,bytes,digest: sha256(bytes) }]
    const manifest = sealPortableManifest({ format: DESKTOP_PORTABLE_TEMPLATE_FORMAT,formatVersion: DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,packageKey: 'a'.repeat(32),title: 'Portable metadata fixture',capturedAt: '2026-11-06T00:00:00.000Z',proseWarning: DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,limits: DESKTOP_PORTABLE_TEMPLATE_LIMITS,coworkers: [{ agentKey: 'c00',name: 'Portable metadata fixture',description: '',setup: { required: false,prompt: '',answered: false },members: members.map(member => ({ path: member.path,bytes: member.bytes.length,kind: member.path === 'config.json' ? 'config' as const : 'text' as const,contentDigest: member.digest,flagged: [],binary: false,textScanned: true })),exclusions: [],redactions: [],strippedConfigKeys: [],requirements: [],envKeys: [],mcpAuth: [] }],fidelity: { binaryAssets: false,userSkillTrees: false,sourceKind: 'local-v1-export',notes: [] },excludedCategories: [] })
    return (await writePortableArchive({ title: manifest.title,packageKey: manifest.packageKey,manifest,members,startedAt: Date.now() })).archiveBytes
}

test.each(reserved)('portable import rejects a valid archive containing internal metadata: %s', async path => {
    const dataRoot = await root(), archiveBytes = await archive(path)
    // The archive has a valid manifest and matching bytes; the import policy must reject it.
    expect((await readPortableArchive(archiveBytes)).members.some(member => member.path === path)).toBe(true)
    await expect(importDesktopPortableTemplate({ requestId: randomUUID(),uploadId: randomUUID(),deps: { dataRoot,readImmutableUpload: async () => archiveBytes } })).rejects.toMatchObject({ status: 400 })
    expect(await listTemplateIds(dataRoot)).toEqual([])
})

test('portable import still accepts ordinary hidden user files', async () => {
    const dataRoot = await root(), archiveBytes = await archive(ordinary[0]!)
    const result = await importDesktopPortableTemplate({ requestId: randomUUID(),uploadId: randomUUID(),deps: { dataRoot,readImmutableUpload: async () => archiveBytes } })
    expect(result.status).toBe('imported')
    if (result.status !== 'imported') throw new Error('Canonical import was not acknowledged')
    expect((await readManifest(dataRoot,result.templateId,result.revision)).coworkers[0]!.files.map(file => file.path)).toContain(ordinary[0])
})

test('canonical install refuses a previously saved manifest with nested internal metadata before creating any destination', async () => {
    const dataRoot = await root(), agentsRoot = join(dataRoot,'agents'), templateId = 'c'.repeat(32)
    await mkdir(agentsRoot)
    const manifest = sealManifest({ version: 1,kind: 'desktop-local-template',templateId,title: 'Old internal metadata',capturedAt: '2026-11-06T00:00:00.000Z',planRevision: 'b'.repeat(64),requestId: randomUUID(),proseWarning: DESKTOP_TEMPLATE_PROSE_WARNING,limits: DESKTOP_TEMPLATE_LIMITS,engineCommit: null,coworkers: [{ agentKey: 'c00',sourceEngineId: 'source',name: 'Source',description: '',setup: { required: false,prompt: '',answered: false },files: [{ path: 'workspace/docs/.rerun-backup-old',bytes: 4,kind: 'text',sourceRevision: 'd'.repeat(64),flagged: [] }],exclusions: [],redactions: [],strippedConfigKeys: [] }] })
    const directory = join(dataRoot,'desktop-templates',templateId,'revisions',manifest.revision)
    await mkdir(directory,{ recursive: true }); await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest))
    const insertIndex = vi.fn(), engineAgentId = `i${'e'.repeat(31)}`
    await expect(installManifest({ dataRoot,agentsRoot,importReceiptId: randomUUID(),templateId,revision: manifest.revision,coworkers: [{ engineAgentId,agentKey: 'c00' }],insertIndex,readIndex: async () => null })).rejects.toMatchObject({ status: 409,message: 'Template manifest has an unsupported path' })
    expect(insertIndex).not.toHaveBeenCalled(); expect(await readdir(agentsRoot)).toEqual([])
    expect(await lstat(join(agentsRoot,engineAgentId)).catch(() => null)).toBeNull()
})
