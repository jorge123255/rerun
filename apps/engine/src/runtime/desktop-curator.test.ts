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

async function coworker(id: string): Promise<LoadedAgent> {
    const config = agentConfigSchema.parse({ name: id, tools: { skills: false } })
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, config)
    return { id, config, soul: '', install: '', env: {}, resolved: { provider: 'openai', model: 'fixture', connection: null } }
}

afterAll(async () => {
    for (const id of ['owner', 'sibling', 'optout', 'redirect', 'destination']) closeSystemDb(id)
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
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
