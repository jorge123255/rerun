import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, afterEach, expect, test } from 'vitest'
import { DESKTOP_TEMPLATE_LIMITS, DESKTOP_TEMPLATE_PROSE_WARNING } from '@rerun/contracts'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import { desktopTemplateRouteAllowed } from './allow.js'
import { installManifest, sealManifest } from './install.js'
import { createDesktopTemplateEngine, type TemplateIndex } from './service.js'

let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => { if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper; await helper.close() })

const localId = '11111111-1111-4111-8111-111111111111'
const draftRequest = '22222222-2222-4222-8222-222222222222'
const captureRequest = '33333333-3333-4333-8333-333333333333'
const importReceipt = '44444444-4444-4444-8444-444444444444'
const secrets = {
    env: 'ENV_SECRET_9f3a',
    memory: 'MEMORY_SECRET_9f3a',
    data: 'DATA_SECRET_9f3a',
    mcp: 'MCP_SECRET_9f3a',
    connector: 'CONNECTOR_SECRET_9f3a',
    history: 'HISTORY_SECRET_9f3a',
    routine: 'ROUTINE_SECRET_9f3a',
    webhook: 'WEBHOOK_SECRET_9f3a',
    path: 'PATH_SECRET_9f3a',
    connection: 'CONN_SECRET_9f3a',
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function memoryIndex(): { index: TemplateIndex; names: Map<string, string> } {
    const names = new Map<string, string>()
    return {
        names,
        index: {
            get: async id => names.has(id) ? { name: names.get(id)! } : null,
            insert: async (id, name) => { names.set(id, name) },
        },
    }
}

async function scaffold() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-template-')))
    roots.push(root)
    const dataRoot = join(root, 'data')
    const agentsRoot = join(root, 'agents')
    const engineAgentId = 'source-ada'
    const folder = join(agentsRoot, engineAgentId)
    await mkdir(join(folder, 'workspace/.rerun'), { recursive: true })
    await mkdir(join(folder, 'skills/Local'), { recursive: true })
    await mkdir(join(folder, 'skills/Owned'), { recursive: true })
    for (const name of ['memory', 'data', 'mcp', 'schedules', 'triggers', 'sessions']) await mkdir(join(folder, name))
    await writeFile(join(folder, 'SOUL.md'), 'Be careful with the notes.\n')
    await writeFile(join(folder, 'config.json'), `${JSON.stringify({
        name: 'source-name', displayName: 'Ada', description: 'Keeps the notes',
        connectionId: secrets.connection, provider: 'PROVIDER_SECRET_9f3a', model: 'MODEL_SECRET_9f3a',
        tools: { shell: true, desktopToolGrants: { shell: true } },
        mcpServers: [{ token: secrets.mcp }],
        selfImprovement: { skills: true },
        setup: { required: false },
    }, null, 2)}\n`)
    await writeFile(join(folder, '.env'), `${secrets.env}\n`)
    await writeFile(join(folder, 'workspace/notes.txt'), 'Pack the local notes.\n')
    await writeFile(join(folder, 'workspace/credentials.txt'), `${secrets.path}\n`)
    await writeFile(join(folder, 'workspace/.rerun/services.json'), `${JSON.stringify({ services: { mail: { skills: ['Owned'] } } })}\n`)
    await writeFile(join(folder, 'skills/Local/SKILL.md'), '---\nname: Local notes\ndescription: Reads the local notes\n---\nUse the notes file.\n')
    await writeFile(join(folder, 'skills/Owned/SKILL.md'), `${secrets.connector}\n`)
    await writeFile(join(folder, 'memory/note.md'), `${secrets.memory}\n`)
    await writeFile(join(folder, 'data/agent.db'), `${secrets.data}\n`)
    await writeFile(join(folder, 'mcp/token.txt'), 'MCP_FILE_SECRET_9f3a\n')
    await writeFile(join(folder, 'schedules/daily.json'), `${secrets.routine}\n`)
    await writeFile(join(folder, 'triggers/hook.json'), `${secrets.webhook}\n`)
    await writeFile(join(folder, 'sessions/chat.json'), `${secrets.history}\n`)
    await symlink('../.env', join(folder, 'workspace/leak.txt'))
    const { index, names } = memoryIndex()
    const engine = createDesktopTemplateEngine({ dataRoot, agentsRoot }, index)
    return { dataRoot, agentsRoot, folder, engineAgentId, engine, names }
}

async function draftAndPlan(engine: ReturnType<typeof createDesktopTemplateEngine>, engineAgentId: string) {
    const draft = await engine.createDraft(draftRequest, 'Pack notes')
    const plan = await engine.plan({ requestId: draftRequest, templateId: draft.templateId, revision: draft.revision, coworkers: [{ agentId: localId, engineAgentId }] })
    return { draft, plan }
}

const selection = [{ agentId: localId, files: ['workspace/notes.txt'], skills: ['Local'] }]

test('a plan shows the instruction text and leaves secrets, links, and connector skills out', async () => {
    const { dataRoot, folder, engine, engineAgentId } = await scaffold()
    const { draft, plan } = await draftAndPlan(engine, engineAgentId)
    const body = JSON.stringify(plan)
    for (const secret of Object.values(secrets)) expect(body).not.toContain(secret)
    expect(body).not.toContain('MCP_FILE_SECRET_9f3a')
    expect(plan.proseWarning).toBe(DESKTOP_TEMPLATE_PROSE_WARNING)
    expect(plan.coworkers[0]?.included.find(file => file.path === 'SOUL.md')?.text).toContain('Be careful with the notes.')
    expect(plan.coworkers[0]?.selectableFiles.map(file => file.path)).toEqual(['workspace/notes.txt'])
    expect(plan.coworkers[0]?.selectableSkills.map(skill => skill.slug)).toEqual(['Local'])
    expect(plan.coworkers[0]?.blocked).toBeNull()
    const config = JSON.parse(plan.coworkers[0]?.included.find(file => file.path === 'config.json')?.text ?? '{}') as { tools: Record<string, boolean>; mcpServers: unknown[]; setup: { required: null } }
    expect(Object.values(config.tools).every(value => value === false)).toBe(true)
    expect(config.mcpServers).toEqual([])
    expect(config.setup.required).toBeNull()
    const reasons = new Map(plan.coworkers[0]?.exclusions.map(item => [item.path, item.reason]))
    expect(reasons.get('.env')).toBe('credentials')
    expect(reasons.get('memory')).toBe('memory')
    expect(reasons.get('data')).toBe('database')
    expect(reasons.get('skills/Owned')).toBe('connector-skill')
    expect(reasons.get('workspace/leak.txt')).toBe('link')
    expect(reasons.get('workspace/credentials.txt')).toBe('credentials')
    expect(reasons.get('mcp')).toBe('credentials')
    expect(reasons.get('schedules')).toBe('routine')
    expect(reasons.get('triggers')).toBe('webhook')
    expect(reasons.get('sessions')).toBe('history')
    const sealed = JSON.parse(await readFile(join(dataRoot, 'desktop-templates', draft.templateId, 'plans', `${plan.planRevision}.json`), 'utf8')) as { bindings: { files: { path: string }[] }[] }
    const bound = sealed.bindings.flatMap(binding => binding.files.map(file => file.path))
    expect(bound).not.toContain('.env')
    expect(bound).not.toContain('workspace/leak.txt')
    expect(bound).not.toContain('skills/Owned/SKILL.md')

    await writeFile(join(folder, 'workspace', 'notes.txt'), 'Pack the local notes. Changed.\n')
    await expect(engine.capture({ requestId: captureRequest, templateId: draft.templateId, revision: draft.revision, planRevision: plan.planRevision, selections: selection })).rejects.toMatchObject({ status: 409 })
    await expect(lstat(join(dataRoot, 'desktop-templates', draft.templateId, 'revisions'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(dataRoot, 'desktop-templates', 'requests', `capture-${captureRequest}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('capture and install copy a fresh coworker and leave the source and a foreign folder alone', async () => {
    const { dataRoot, agentsRoot, folder, engine, engineAgentId, names } = await scaffold()
    const { draft, plan } = await draftAndPlan(engine, engineAgentId)
    const notes = join(folder, 'workspace/notes.txt')
    const info = await stat(notes)
    await utimes(notes, info.atime, new Date(info.mtimeMs + 5_000))
    const again = await engine.plan({ requestId: draftRequest, templateId: draft.templateId, revision: draft.revision, coworkers: [{ agentId: localId, engineAgentId }] })
    expect(again.planRevision).not.toBe(plan.planRevision)
    expect(again.coworkers).toEqual(plan.coworkers)
    await expect(engine.capture({ requestId: captureRequest, templateId: draft.templateId, revision: draft.revision, planRevision: plan.planRevision, selections: selection })).rejects.toMatchObject({ status: 409 })
    await expect(lstat(join(dataRoot, 'desktop-templates', draft.templateId, 'revisions'))).rejects.toMatchObject({ code: 'ENOENT' })

    const retry = '66666666-6666-4666-8666-666666666666'
    const captured = await engine.capture({ requestId: retry, templateId: draft.templateId, revision: draft.revision, planRevision: again.planRevision, selections: selection })
    await writeFile(notes, 'Changed after capture succeeded.\n')
    expect(await engine.capture({ requestId: retry, templateId: draft.templateId, revision: draft.revision, planRevision: again.planRevision, selections: selection })).toEqual(captured)
    const importId = `i${'a'.repeat(31)}`
    const installed = await engine.install({ importReceiptId: importReceipt, templateId: captured.templateId, revision: captured.revision, coworkers: [{ engineAgentId: importId, agentKey: 'c00' }] })
    expect(installed.status).toBe('ready')
    expect(installed.coworkers).toEqual([expect.objectContaining({ engineAgentId: importId, phase: 'indexed' })])
    expect(names.get(importId)).toBe('Ada')
    const destination = join(agentsRoot, importId)
    const config = JSON.parse(await readFile(join(destination, 'config.json'), 'utf8')) as {
        tools: Record<string, unknown>
        mcpServers: unknown[]
        connectionId: null
        selfImprovement: Record<string, boolean>
        setup: { required: null; completedAt: null; sessionId: null }
    }
    expect(Object.values(config.tools).every(value => value === false)).toBe(true)
    expect(config.tools.desktopToolGrants).toBeUndefined()
    expect(Object.values(config.selfImprovement).every(value => value === false)).toBe(true)
    expect(config.mcpServers).toEqual([])
    expect(config.connectionId).toBeNull()
    expect(config.setup).toEqual({ required: null, completedAt: null, sessionId: null })
    expect(await readFile(join(destination, 'SOUL.md'), 'utf8')).toContain('Be careful with the notes.')
    expect(await readFile(join(destination, 'workspace/notes.txt'), 'utf8')).toContain('Pack the local notes.')
    expect(await readFile(join(destination, 'skills/Local/SKILL.md'), 'utf8')).toContain('Use the notes file.')
    for (const relative of ['.env', 'memory', 'data', 'mcp', 'schedules', 'triggers', 'sessions', 'workspace/leak.txt', 'workspace/credentials.txt', 'skills/Owned']) {
        await expect(lstat(join(destination, relative))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(folder, '.env'), 'utf8')).toContain(secrets.env)
    expect(await readFile(join(folder, 'config.json'), 'utf8')).toContain(secrets.mcp)
    expect(await readdir(folder)).not.toContain('.desktop-template-import.json')

    const before = (await readdir(agentsRoot)).sort()
    await writeFile(join(destination, 'config.json'), JSON.stringify({ ...config, setup: { required: true, completedAt: '2026-11-05T00:00:00Z', sessionId: 'owned-setup' } }))
    const replay = await engine.install({ importReceiptId: importReceipt, templateId: captured.templateId, revision: captured.revision, coworkers: [{ engineAgentId: importId, agentKey: 'c00' }] })
    expect(replay.status).toBe('ready')
    expect(JSON.parse(await readFile(join(destination, 'config.json'), 'utf8')).setup.sessionId).toBe('owned-setup')
    expect((await readdir(agentsRoot)).sort()).toEqual(before)
    expect(names.size).toBe(1)

    const foreignId = `i${'b'.repeat(31)}`
    await mkdir(join(agentsRoot, foreignId), { mode: 0o700 })
    await writeFile(join(agentsRoot, foreignId, 'keep.txt'), 'keep-foreign')
    const foreign = await engine.install({ importReceiptId: '55555555-5555-4555-8555-555555555555', templateId: captured.templateId, revision: captured.revision, coworkers: [{ engineAgentId: foreignId, agentKey: 'c00' }] })
    expect(foreign.status).toBe('uncertain')
    expect(foreign.coworkers[0]).toMatchObject({ engineAgentId: foreignId, phase: 'foreign' })
    expect(await readFile(join(agentsRoot, foreignId, 'keep.txt'), 'utf8')).toBe('keep-foreign')
    expect(await readdir(join(agentsRoot, foreignId))).toEqual(['keep.txt'])
    expect(names.size).toBe(1)
})

test('unsupported manifest metadata and a confined-but-disallowed path are refused before a destination exists', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-template-manifest-')))
    roots.push(root)
    const dataRoot = join(root, 'data')
    const agentsRoot = join(root, 'agents')
    await mkdir(agentsRoot, { recursive: true })
    const templateId = 'e'.repeat(32)
    const manifest = sealManifest({
        version: 1, kind: 'desktop-local-template', templateId, title: 'Pack notes', capturedAt: '2026-11-05T12:00:00.000Z',
        planRevision: 'c'.repeat(64), requestId: '77777777-7777-4777-8777-777777777777',
        proseWarning: DESKTOP_TEMPLATE_PROSE_WARNING, limits: DESKTOP_TEMPLATE_LIMITS, engineCommit: null,
        coworkers: [{
            agentKey: 'c00', sourceEngineId: 'source-ada', name: 'Ada', description: '',
            setup: { required: false, prompt: '', answered: true },
            files: [{ path: 'workspace/.rerun/secret.txt', bytes: 4, kind: 'text', sourceRevision: 'd'.repeat(64), flagged: [] }],
            exclusions: [], redactions: [], strippedConfigKeys: [],
        }],
    })
    const directory = join(dataRoot, 'desktop-templates', templateId, 'revisions', manifest.revision)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    const index = { get: async () => null, insert: async () => { throw new Error('index insert') } }
    await expect(installManifest({ dataRoot, agentsRoot, importReceiptId: importReceipt, templateId, revision: manifest.revision, coworkers: [{ engineAgentId: `i${'a'.repeat(31)}`, agentKey: 'c00' }], insertIndex: index.insert, readIndex: index.get })).rejects.toMatchObject({ status: 409 })
    expect(await readdir(agentsRoot)).toEqual([])

    const extra = { ...manifest, unexpected: true }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(extra))
    await expect(installManifest({ dataRoot, agentsRoot, importReceiptId: importReceipt, templateId, revision: manifest.revision, coworkers: [{ engineAgentId: `i${'a'.repeat(31)}`, agentKey: 'c00' }], insertIndex: index.insert, readIndex: index.get })).rejects.toMatchObject({ status: 409 })
    expect(await readdir(agentsRoot)).toEqual([])
})

test('desktop template routes stay on the trusted engine surface', () => {
    const id = 'a'.repeat(32)
    expect(desktopTemplateRouteAllowed('GET', '/desktop/templates')).toBe(true)
    expect(desktopTemplateRouteAllowed('GET', `/desktop/templates/${id}`)).toBe(true)
    expect(desktopTemplateRouteAllowed('POST', '/desktop/templates/draft')).toBe(true)
    expect(desktopTemplateRouteAllowed('POST', '/desktop/templates/plan')).toBe(true)
    expect(desktopTemplateRouteAllowed('POST', '/desktop/templates/capture')).toBe(true)
    expect(desktopTemplateRouteAllowed('POST', '/desktop/templates/install')).toBe(true)
    expect(desktopTemplateRouteAllowed('POST', '/desktop/templates')).toBe(false)
    expect(desktopTemplateRouteAllowed('DELETE', `/desktop/templates/${id}`)).toBe(false)
    expect(desktopTemplateRouteAllowed('GET', '/desktop/templates/draft')).toBe(false)
    expect(desktopTemplateRouteAllowed('POST', '/desktop/agents')).toBe(false)
})


test('a linked destination ancestor cannot create directories outside the owned folder',async()=>{
    const {folder}=await scaffold()
    const outside=await realpath(await mkdtemp(join(tmpdir(),'rerun-template-outside-')))
    roots.push(outside)
    await symlink(outside,join(folder,'redirect'))
    const {writeExclusiveFile}=await import('./files.js')
    await expect(writeExclusiveFile(folder,'redirect/new-folder/note.txt',Buffer.from('private'))).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
})
