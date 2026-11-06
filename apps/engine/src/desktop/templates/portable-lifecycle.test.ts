import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { DESKTOP_PORTABLE_TEMPLATE_LIMITS } from '@rerun/contracts'
import { createDesktopTemplateEngine } from './service.js'
import { createDesktopPortableTemplateService } from './portable-service.js'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import { beforeAll, afterAll } from 'vitest'

let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => {
    if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER
    else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper
    await helper.close()
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function seedCoworker(agentsRoot: string, engineId: string) {
    const folder = join(agentsRoot, engineId)
    await mkdir(join(folder, 'workspace'), { recursive: true })
    await mkdir(join(folder, 'skills', 'demo'), { recursive: true })
    await writeFile(join(folder, 'SOUL.md'), '# Soul\n', { mode: 0o600 })
    await writeFile(join(folder, 'INSTALL.md'), 'Say hello\n', { mode: 0o600 })
    await writeFile(join(folder, 'config.json'), JSON.stringify({
        name: 'demo', displayName: 'Demo', description: 'd', kind: 'user', enabled: true, ephemeral: false,
        tools: {}, mcpServers: [], selfImprovement: {}, setup: { required: false, completedAt: null, sessionId: null },
    }, null, 2) + '\n', { mode: 0o600 })
    await writeFile(join(folder, 'workspace', 'note.txt'), 'hello\n', { mode: 0o600 })
    await writeFile(join(folder, 'workspace', 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), { mode: 0o600 })
    await writeFile(join(folder, 'skills', 'demo', 'SKILL.md'), '---\nname: Demo\ndescription: demo\n---\nbody\n', { mode: 0o600 })
    await writeFile(join(folder, 'skills', 'demo', 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]), { mode: 0o600 })
}

test('binary-aware capture, export, import, delete and lost-ack reuse stay independent of source installs', async () => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'desktop-portable-data-')))
    const agentsRoot = await realpath(await mkdtemp(join(tmpdir(), 'desktop-portable-agents-')))
    roots.push(dataRoot, agentsRoot)
    await seedCoworker(agentsRoot, 'agent_source_1')
    const names = new Map<string, string>()
    const engine = createDesktopTemplateEngine({ dataRoot, agentsRoot }, {
        get: async id => names.has(id) ? { name: names.get(id)! } : null,
        insert: async (id, name) => { names.set(id, name) },
    }, {
        includeBinary: true,
        requireTrustedOwnership: true,
        skillOwnership: async () => 'user',
    })
    const localId = '11111111-1111-4111-8111-111111111111'
    const draft = await engine.createDraft('22222222-2222-4222-8222-222222222222', 'Portable Demo')
    const plan = await engine.plan({
        requestId: draft.requestId,
        templateId: draft.templateId,
        revision: draft.revision,
        coworkers: [{ agentId: localId, engineAgentId: 'agent_source_1' }],
    })
    expect(plan.portableCapture?.binaryAssets).toBe(true)
    expect(plan.coworkers[0].selectableFiles.some(file => file.kind === 'binary')).toBe(true)
    expect(plan.coworkers[0].selectableSkills[0].files.some(file => file.binary)).toBe(true)
    const captureRequest = '33333333-3333-4333-8333-333333333333'
    const captured = await engine.capture({
        requestId: captureRequest,
        templateId: draft.templateId,
        revision: draft.revision,
        planRevision: plan.planRevision,
        selections: [{
            agentId: localId,
            files: plan.coworkers[0].selectableFiles.map(file => file.path),
            skills: plan.coworkers[0].selectableSkills.map(skill => skill.slug),
        }],
    })
    // Lost acknowledgement of the same capture must not create a second revision.
    const again = await engine.capture({
        requestId: captureRequest,
        templateId: draft.templateId,
        revision: draft.revision,
        planRevision: plan.planRevision,
        selections: [{
            agentId: localId,
            files: plan.coworkers[0].selectableFiles.map(file => file.path),
            skills: plan.coworkers[0].selectableSkills.map(skill => skill.slug),
        }],
    })
    expect(again.revision).toBe(captured.revision)

    const artifacts = new Map<string, Buffer>()
    const uploads = new Map<string, Buffer>()
    const portable = createDesktopPortableTemplateService({
        dataRoot,
        publishDownloadArtifact: async (bytes) => {
            const artifactId = 'b'.repeat(32)
            artifacts.set(artifactId, bytes)
            return { artifactId }
        },
        readImmutableUpload: async uploadId => {
            const bytes = uploads.get(uploadId)
            if (!bytes) throw new Error('missing upload')
            return bytes
        },
    })
    const exported = await portable.handle({
        operation: 'export',
        requestId: '44444444-4444-4444-8444-444444444444',
        templateId: captured.templateId,
        revision: captured.revision,
    })
    expect(exported.status).toBe('exported')
    if (exported.status !== 'exported') return
    uploads.set('55555555-5555-4555-8555-555555555555', artifacts.get(exported.artifactId)!)

    const imported = await portable.handle({
        operation: 'import-package',
        requestId: '66666666-6666-4666-8666-666666666666',
        uploadId: '55555555-5555-4555-8555-555555555555',
    })
    expect(imported.status).toBe('imported')
    if (imported.status !== 'imported') return
    expect(imported.templateId).not.toBe(captured.templateId)

    const deleted = await portable.handle({
        operation: 'delete',
        requestId: '77777777-7777-4777-8777-777777777777',
        templateId: imported.templateId,
        revision: imported.revision,
    })
    expect(deleted.status).toBe('deleted')
    // Exported artifact bytes outside ownership remain.
    expect(artifacts.get(exported.artifactId)?.length).toBeGreaterThan(0)
    expect(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes).toBe(25 * 1024 * 1024)
})

test('unknown ownership and connector skills are blocked; missing ownership callback fails closed for portable capture', async () => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'desktop-portable-own-')))
    const agentsRoot = await realpath(await mkdtemp(join(tmpdir(), 'desktop-portable-own-agents-')))
    roots.push(dataRoot, agentsRoot)
    await seedCoworker(agentsRoot, 'agent_source_2')
    const engine = createDesktopTemplateEngine({ dataRoot, agentsRoot }, undefined, {
        includeBinary: true,
        requireTrustedOwnership: true,
        skillOwnership: async ({ slug }) => slug === 'demo' ? 'connector' : 'unknown',
    })
    const draft = await engine.createDraft('88888888-8888-4888-8888-888888888888', 'Owned')
    const plan = await engine.plan({
        requestId: draft.requestId,
        templateId: draft.templateId,
        revision: draft.revision,
        coworkers: [{ agentId: '11111111-1111-4111-8111-111111111111', engineAgentId: 'agent_source_2' }],
    })
    expect(plan.coworkers[0].selectableSkills).toEqual([])
    expect(plan.coworkers[0].exclusions.some(item => item.reason === 'connector-skill')).toBe(true)

    const closed = createDesktopTemplateEngine({ dataRoot, agentsRoot }, undefined, {
        includeBinary: true,
        requireTrustedOwnership: true,
    })
    const draft2 = await closed.createDraft('99999999-9999-4999-8999-999999999999', 'Closed')
    await expect(closed.plan({
        requestId: draft2.requestId,
        templateId: draft2.templateId,
        revision: draft2.revision,
        coworkers: [{ agentId: '11111111-1111-4111-8111-111111111111', engineAgentId: 'agent_source_2' }],
    })).rejects.toMatchObject({ status: 503 })
})
