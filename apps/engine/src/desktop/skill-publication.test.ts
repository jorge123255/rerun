import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'
import { bindDesktopSkillOwnerReader } from './service-skills/authority.js'
import { archiveSkillFolder, deleteSkillFolder, deleteConfinedFile, listPublishedSkills, parseSkillDraft, publishNewSkill, readConfinedFile, readPublishedSkill, replaceSkillManifest, setSkillPublishHooksForTests, writeConfinedFile } from './skill-publication.js'

const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
let fixture: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
let root: string, skills: string
beforeAll(async () => { fixture = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = fixture.path }, 30_000)
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-skills-publication-')))
    skills = join(root, 'skills')
    await mkdir(join(root, 'workspace'))
    await publishNewSkill(skills, 'notes', { name: 'Notes', description: 'Reuse a procedure', body: 'Original procedure' })
})
afterEach(async () => { setSkillPublishHooksForTests(null); await rm(root, { recursive: true, force: true }) })
afterAll(async () => { if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper; await fixture.close() })

test('creates and reads full text, refuses duplicate names, and retains prior inode bytes on replacement', async () => {
    const folder = join(skills, 'notes')
    await writeConfinedFile(folder, 'references/steps.md', 'first', { createOnly: true })
    const read = await readConfinedFile(folder, 'references/steps.md')
    expect(read).toMatchObject({ content: 'first', truncated: false })
    await expect(writeConfinedFile(folder, 'references/steps.md', 'collision', { createOnly: true })).rejects.toThrow('already exists')
    await writeConfinedFile(folder, 'references/steps.md', 'second', { completeRead: true, baseIdentity: read!.identity })
    expect((await readConfinedFile(folder, 'references/steps.md'))?.content).toBe('second')
    const kept = (await readdir(join(folder, 'references'))).filter(name => name.startsWith('.rerun-skill-bak-'))
    expect(kept).toHaveLength(1)
    expect(await readFile(join(folder, 'references', kept[0]!), 'utf8')).toBe('first')
    expect((await readPublishedSkill(skills, 'notes'))?.files).toEqual(['references/steps.md'])
})

test.each(['SKILL.md', 'skill.md', './sKiLl.Md'])('bundled file tools cannot overwrite, delete, or import a manifest alias %s', async path => {
    const folder = join(skills, 'notes')
    const before = await readFile(join(folder, 'SKILL.md'))
    await expect(writeConfinedFile(folder, path, 'Changed manifest')).rejects.toThrow('other than SKILL.md')
    await expect(deleteConfinedFile(folder, path)).rejects.toThrow('other than SKILL.md')
    await expect(publishNewSkill(skills, 'imported', { name: 'Imported', description: '', body: 'Procedure', files: [{ path, content: 'Changed manifest' }] })).rejects.toThrow('Use the skill body')
    expect(await readFile(join(folder, 'SKILL.md'))).toEqual(before)
    expect(await readPublishedSkill(skills, 'imported')).toBeNull()
})

test('an in-place edit changes the opaque version and a truncated page cannot overwrite its tail', async () => {
    const folder = join(skills, 'notes'), path = join(folder, 'steps.md')
    await writeConfinedFile(folder, 'steps.md', 'old')
    const read = await readConfinedFile(folder, 'steps.md')
    await writeFile(path, 'outside edit')
    await expect(writeConfinedFile(folder, 'steps.md', 'stale', { completeRead: true, baseIdentity: read!.identity })).rejects.toThrow('changed')
    expect(await readFile(path, 'utf8')).toBe('outside edit')
    await writeFile(path, 'a'.repeat(150_000))
    const partial = await readConfinedFile(folder, 'steps.md')
    expect(partial).toMatchObject({ truncated: true })
    expect(partial!.content).toHaveLength(100_000)
    await expect(writeConfinedFile(folder, 'steps.md', partial!.content.slice(0, 10), { completeRead: true, baseIdentity: partial!.identity })).rejects.toThrow('partly read')
    expect((await readFile(path)).length).toBe(150_000)
})

test('interrupted replacement restores the old manifest and exposes the unsaved draft instead of discarding it', async () => {
    const opened = (await readPublishedSkill(skills, 'notes'))!
    setSkillPublishHooksForTests({ afterOriginalMoved: () => { throw new Error('interrupted fixture') } })
    await expect(replaceSkillManifest(skills, 'notes', { body: 'Unacknowledged draft', baseIdentity: opened.identity })).rejects.toThrow('interrupted fixture')
    setSkillPublishHooksForTests(null)
    await expect(readPublishedSkill(skills, 'notes')).rejects.toThrow('Recovery copies')
    const restored = (await readPublishedSkill(skills, 'notes'))!
    expect(restored.body).toBe('Original procedure')
    const draft = restored.files.find(name => name.includes('.draft-'))!
    expect(draft).toBeTruthy()
    expect(await readFile(join(skills, 'notes', draft), 'utf8')).toContain('Unacknowledged draft')
    expect((await readdir(skills)).filter(name => name.startsWith('.rerun-skill-journal-'))).toEqual([])
})

test('recovering another skill refuses a newly managed owner and leaves every interrupted byte in place', async () => {
    await publishNewSkill(skills, 'other', { name: 'Other', description: '', body: 'Other skill' })
    setSkillPublishHooksForTests({ afterOriginalMoved: () => { throw new Error('interrupted fixture') } })
    await expect(replaceSkillManifest(skills, 'notes', { body: 'Pending managed draft' })).rejects.toThrow()
    setSkillPublishHooksForTests(null)
    await mkdir(join(root, 'workspace', '.rerun'))
    await writeFile(join(root, 'workspace', '.rerun', 'services.json'), JSON.stringify({ services: { calendar: { skills: ['notes'] } } }))
    const before = await readdir(join(skills, 'notes'))
    await expect(readPublishedSkill(skills, 'other')).rejects.toThrow(/calendar|app|read.only/i)
    expect(await readdir(join(skills, 'notes'))).toEqual(before)
})

test('listing returns summaries, preserves original multiline YAML semantics and bounds aggregate manifests', async () => {
    expect(parseSkillDraft('---\nname: Notes\ndescription: >\n  First line\n  second line\n---\nProcedure').description).toBe('First line second line\n')
    const list = await listPublishedSkills(skills)
    expect(list).toEqual([{ slug: 'notes', name: 'Notes', description: 'Reuse a procedure', body: '', files: [] }])
    for (let index = 0; index < 6; index++) {
        const folder = join(skills, `large-${index}`)
        await mkdir(folder)
        await writeFile(join(folder, 'SKILL.md'), `---\nname: Large\ndescription: Bounded\n---\n${'x'.repeat(2 * 1024 * 1024)}`)
    }
    await expect(listPublishedSkills(skills)).rejects.toThrow('index is too large')
})


test('desktop canonical ownership blocks all mutation and export paths after workspace footprints are removed', async () => {
    await writeConfinedFile(join(skills, 'notes'), 'reference.md', 'Retain this reference')
    const previous = process.env.RERUN_DESKTOP_APP
    process.env.RERUN_DESKTOP_APP = '1'
    bindDesktopSkillOwnerReader(async () => new Map([['notes', 'Calendar']]))
    try {
        const original = await readFile(join(skills, 'notes', 'SKILL.md'), 'utf8')
        await expect(replaceSkillManifest(skills, 'notes', { body: 'Changed' })).rejects.toThrow('managed by its app')
        await expect(writeConfinedFile(join(skills, 'notes'), 'reference.md', 'Changed')).rejects.toThrow('managed by its app')
        await expect(deleteConfinedFile(join(skills, 'notes'), 'reference.md')).rejects.toThrow('managed by its app')
        await expect(deleteSkillFolder(skills, 'notes')).rejects.toThrow('managed by its app')
        await expect(archiveSkillFolder(skills, 'notes')).rejects.toThrow('managed by its app')
        await expect(publishNewSkill(skills, 'svc-unknown', { name: 'Unknown', description: '', body: 'Unsafe' })).rejects.toThrow('managed by its app')
        expect(await readFile(join(skills, 'notes', 'SKILL.md'), 'utf8')).toBe(original)
        expect(await readFile(join(skills, 'notes', 'reference.md'), 'utf8')).toBe('Retain this reference')
    } finally {
        if (previous === undefined) delete process.env.RERUN_DESKTOP_APP; else process.env.RERUN_DESKTOP_APP = previous
        bindDesktopSkillOwnerReader(async () => { throw new Error('No active fixture authority') })
    }
})

test('desktop publication repeats canonical authority under the kernel lease before its rename', async () => {
    const previous = process.env.RERUN_DESKTOP_APP
    process.env.RERUN_DESKTOP_APP = '1'
    let reads = 0
    bindDesktopSkillOwnerReader(async () => ++reads >= 3 ? new Map([['late-owner', 'Calendar']]) : new Map())
    try {
        await expect(publishNewSkill(skills, 'late-owner', { name: 'Late owner', description: '', body: 'Never published' })).rejects.toThrow('managed by its app')
        expect((await readdir(skills)).includes('late-owner')).toBe(false)
    } finally {
        if (previous === undefined) delete process.env.RERUN_DESKTOP_APP; else process.env.RERUN_DESKTOP_APP = previous
        bindDesktopSkillOwnerReader(async () => { throw new Error('No active fixture authority') })
    }
})
