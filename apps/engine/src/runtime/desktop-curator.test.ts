import { mkdtempSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import type { LoadedAgent } from '../agents/types.js'

const generate = vi.hoisted(() => vi.fn())
const embed = vi.hoisted(() => vi.fn(() => { throw Error('Unexpected embedding request') }))
vi.mock('../agents/structured.js', () => ({ generateStructured: generate }))
vi.mock('../agents/providers.js', () => ({ modelFor: () => ({}) }))
vi.mock('../memory/embed.js', () => ({ embedText: embed }))

const root = mkdtempSync(join(tmpdir(), 'rerun-desktop-curator-'))
vi.stubEnv('RERUN_DATA_DIR', root)
vi.stubEnv('RERUN_DESKTOP_APP', '1')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir } = await import('../config/paths.js')
const { closeSystemDb } = await import('../db/systemDb.js')
const { bumpMemoryAccess, listMemories } = await import('../db/repos/memories.js')
const { addDesktopMemory, listDesktopMemory } = await import('../desktop/memory-store.js')
const { writeMemoryFile } = await import('../memory/files.js')
const { runCurator } = await import('./curator.js')
const { agentRoutes } = await import('../http/routes/agents.js')
const { shutdownDesktopSemanticMemory } = await import('../desktop/semantic-memory/runtime.js')

async function coworker(id: string): Promise<LoadedAgent> {
    const config = agentConfigSchema.parse({ name: id, tools: { skills: false } })
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, config)
    return { id, config, soul: '', install: '', env: {}, resolved: { provider: 'openai', model: 'fixture', connection: null } }
}

afterAll(async () => {
    try {
        // agentRoutes installs the semantic observer; drain its background reconcile
        // before closing databases or changing the root its lazy readers resolve.
        await shutdownDesktopSemanticMemory()
        for (const id of ['owner', 'sibling', 'optout', 'redirect', 'destination', 'pending-memory', 'pending-autoMemory', 'pending-enabled']) closeSystemDb(id)
        await rm(root, { recursive: true, force: true })
    } finally { vi.unstubAllEnvs() }
})

it('learns, corrects and removes indexed notes using only the selected Mac coworker’s candidates', async () => {
    const owner = await coworker('owner')
    const sibling = await coworker('sibling')
    const save = (agent: LoadedAgent, content: string) => addDesktopMemory(agent.id, { content, kind: 'fact', tags: ['workshop'] })
    const keep = await save(owner, 'The oriole cabinet is blue.')
    const obsolete = await save(owner, 'The oriole cabinet is downstairs.')
    const foreign = await save(sibling, 'The oriole cabinet contains a private sibling marker.')
    const legacy = await writeMemoryFile(owner.id, 'An oriole cabinet file-only note.')
    await bumpMemoryAccess(owner.id, [keep], 'full')
    const original = (await listMemories(owner.id)).find(row => row.id === keep)!

    generate.mockResolvedValueOnce({ memory: { updateId: keep, content: 'The oriole cabinet is green.' }, obsoleteIds: [obsolete, foreign, legacy.id] })
    await runCurator(owner, 'session', 'The oriole cabinet is green now.', 'Understood.')
    const prompt = generate.mock.calls[0][0].prompt
    expect(prompt).toContain(keep)
    expect(prompt).toContain(obsolete)
    expect(prompt).not.toContain('private sibling marker')
    expect(prompt).not.toContain('file-only note')
    const [files, rows] = await listDesktopMemory(owner.id)
    expect(files.map(note => note.id).sort()).toEqual([keep, legacy.id].sort())
    expect(files.find(note => note.id === keep)).toMatchObject({ content: 'The oriole cabinet is green.', kind: 'fact', tags: ['workshop'], createdAt: original.createdAt })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: keep, content: 'The oriole cabinet is green.', accessCount: original.accessCount })
    expect((await listDesktopMemory(sibling.id))[0].map(note => note.id)).toEqual([foreign])

    generate.mockResolvedValueOnce({ memory: { updateId: null, content: 'The workbench is by the window.' }, obsoleteIds: [] })
    await runCurator(owner, 'session', 'The workbench is by the window.', 'Understood.')
    expect((await listDesktopMemory(owner.id))[0]).toContainEqual(expect.objectContaining({ kind: 'learned', content: 'The workbench is by the window.' }))
    expect(embed).not.toHaveBeenCalled()
})

it('honors a Mac coworker’s memory and automatic learning switches', async () => {
    const agent = await coworker('optout')
    generate.mockClear()
    agent.config.tools.memory = false
    await runCurator(agent, 'session', 'Oriole cabinet', 'Understood.')
    agent.config.tools.memory = true
    agent.config.selfImprovement.autoMemory = false
    await runCurator(agent, 'session', 'Oriole cabinet', 'Understood.')
    expect(generate).not.toHaveBeenCalled()
    expect((await listDesktopMemory(agent.id))[0]).toEqual([])
})

it.each(['memory', 'autoMemory', 'enabled'])('disabling %s discards a pending Mac review even after learning resumes', async key => {
    const agent = await coworker('pending-' + key)
    const original = 'The oriole cabinet is green.'
    const note = await addDesktopMemory(agent.id, { content: original, kind: 'fact', tags: [] })
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    generate.mockClear()
    generate.mockImplementationOnce(async () => {
        started.resolve()
        await finish.promise
        return { memory: { updateId: null, content: 'The oriole cabinet is blue.' }, obsoleteIds: [note] }
    })
    const patch = async (body: object) => {
        const response = await agentRoutes.request('/' + agent.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        expect(response.status).toBe(200)
    }
    const setting = (value: boolean) => key === 'memory' ? { tools: { memory: value } } : { selfImprovement: { [key]: value } }
    const pending = runCurator(agent, 'earlier', 'Oriole cabinet', 'Understood.')
    await started.promise
    try {
        const signal = generate.mock.calls[0][0].abortSignal
        await patch({ verbosity: 'concise' })
        expect(signal.aborted).toBe(false)
        await patch(setting(false))
        expect(signal.aborted).toBe(true)
        // A different existing chat finishes after Save with the same stale LoadedAgent.
        await runCurator(agent, 'late', 'Oriole cabinet', 'Understood.')
        expect(generate).toHaveBeenCalledTimes(1)
        await patch(setting(true))
    } finally {
        finish.resolve()
        await pending
    }
    expect((await listDesktopMemory(agent.id))[0].map(row => row.content)).toEqual([original])
    generate.mockResolvedValueOnce({ memory: { updateId: note, content: 'Updated in the new turn.' }, obsoleteIds: [] })
    await runCurator(agent, 'new', 'Oriole cabinet', 'Understood.')
    expect((await listDesktopMemory(agent.id))[0].map(row => row.content)).toEqual(['Updated in the new turn.'])
})

it('cannot read or create learned notes through a redirect to another coworker', async () => {
    const owner = await coworker('redirect')
    const sibling = await coworker('destination')
    const original = await addDesktopMemory(sibling.id, { content: 'The oriole case holds the sibling’s brass key.', kind: 'fact', tags: [] })
    await symlink(join(agentDir(sibling.id), 'memory'), join(agentDir(owner.id), 'memory'), 'dir')
    generate.mockClear()
    generate.mockResolvedValueOnce({ memory: { updateId: null, content: 'An oriole case arrived today.' }, obsoleteIds: [original] })
    await runCurator(owner, 'session', 'Oriole case', 'Understood.')
    for (const [request] of generate.mock.calls) expect(request.prompt).not.toContain('sibling’s brass key')
    expect((await listDesktopMemory(sibling.id))[0].map(note => [note.id, note.content])).toEqual([[original, 'The oriole case holds the sibling’s brass key.']])
})
