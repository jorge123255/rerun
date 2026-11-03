import type { LoadedAgent } from '../../agents/types.js'
import { contextTextPart, TOOL_KEYS } from '@rerun/contracts'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-mac-recall-'))
const embedText = vi.hoisted(() => vi.fn(() => { throw Error('unexpected embedding call') }))
vi.mock('../../memory/embed.js', () => ({ embedText }))
const { recallMemories, recallSection, buildSystemPrompt, systemPromptText } = await import('../../agents/systemPrompt.js')
const { recallDesktopMemory, updateDesktopMemory } = await import('../../desktop/memory-store.js')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { agentDir } = await import('../../config/paths.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { closeSystemDb, getSystemDb } = await import('../../db/systemDb.js')
const { indexMemory, listMemories } = await import('../../db/repos/memories.js')
const { writeMemoryFile } = await import('../../memory/files.js')
let app = createServer()

async function coworker(id: string) {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: id }))
}
const recall = (id: string, body: unknown) => app.request(`/agents/${id}/memories/recall`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
async function remember(id: string, content: string) {
    const res = await app.request(`/agents/${id}/memories`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, kind: 'fact', tags: ['qa'] }),
    })
    expect(res.status).toBe(201)
    return (await res.json()).id as string
}
async function matches(id: string, body: unknown) {
    const res = await recall(id, body)
    expect(res.status).toBe(200)
    return (await res.json()).memories as { id: string; status: string; strength: number }[]
}

beforeEach(() => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('unexpected network request') }))
})
afterEach(() => {
    expect(embedText).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

it('uses local keyword coverage, decay and limit after reopen, without changing notes or index stats', async () => {
    const a = 'recall-owner', b = 'recall-sibling'
    await Promise.all([a, b].map(coworker))
    const partial = await remember(a, 'Café reservations')
    const full = await remember(a, 'Café reservations for the brass band')
    const dormant = await remember(a, 'Café brass in the distant past')
    await remember(b, 'Secret brass café booking')
    const { client } = await getSystemDb(a)
    await client.execute({ sql: 'UPDATE memories SET last_accessed_at = ? WHERE id = ?', args: ['2000-01-01', dormant] })
    const before = await listMemories(a)
    const note = join(agentDir(a), 'memory', full + '.md')
    const markdown = await readFile(note, 'utf8')
    const query = 'where is the cafe BRASS?'
    const rows = await matches(a, { query })
    expect(rows.map(row => row.id)).toEqual([full, partial])
    expect(rows[0]).toEqual({ id: full, kind: 'fact', tags: ['qa'], content: 'Café reservations for the brass band',
        createdAt: expect.any(String), strength: expect.any(Number), status: 'active' })
    const all = await matches(a, { query, includeDormant: true })
    expect(all.map(row => row.id)).toEqual([full, partial, dormant])
    expect(all[2].status).toBe('dormant')
    expect(await matches(a, { query: 'secret' })).toEqual([])
    expect(await matches(a, { query: 'where is the?' })).toEqual([])
    closeSystemDb(a)
    app = createServer()
    expect((await matches(a, { query, limit: 1 })).map(row => row.id)).toEqual([full])
    expect(await listMemories(a)).toEqual(before)
    expect(await readFile(note, 'utf8')).toBe(markdown)
})

it('finds visible unindexed notes without creating data, recovering markers or following index/file redirects', async () => {
    const a = 'recall-manual', b = 'recall-foreign', alias = 'recall-alias'
    await Promise.all([a, b, alias].map(coworker))
    expect(await matches(a, { query: 'manual' })).toEqual([])
    const own = await writeMemoryFile(a, 'Visible handmade note', 'preference', ['invisible'])
    const other = await writeMemoryFile(b, 'Foreign secret')
    const root = join(agentDir(a), 'memory')
    const marker = join(root, '.adding-incomplete')
    await writeFile(marker, 'partial')
    await symlink(other.path, join(root, other.id + '.md'))
    expect((await matches(a, { query: 'handmade' })).map(row => row.id)).toEqual([own.id])
    expect(await matches(a, { query: 'invisible' })).toEqual([])
    expect(await readFile(marker, 'utf8')).toBe('partial')
    expect(await readdir(agentDir(a))).not.toContain('data')
    await indexMemory({ ...other, agentId: a, accessCount: 0, lastAccessedAt: null }, null)
    expect(await matches(a, { query: 'secret' })).toEqual([])
    await symlink(root, join(agentDir(alias), 'memory'), 'dir')
    expect((await recall(alias, { query: 'handmade' })).status).toBe(403)
    closeSystemDb(a)
    const database = join(agentDir(a), 'data', 'system.db')
    await rename(database, database + '.saved')
    await symlink(database + '.saved', database)
    expect((await recall(a, { query: 'handmade' })).status).toBe(403)
})

it('validates input, identifies a missing coworker and reports an unreadable index', async () => {
    const id = 'recall-invalid'
    await coworker(id)
    for (const body of [{}, { query: '  ' }, { query: 'x', limit: 0 }, { query: 'x', limit: 21 }, { query: 'x', includeDormant: 'true' }, { query: 'x', agentId: id }]) {
        expect((await recall(id, body)).status).toBe(400)
    }
    expect((await recall('recall-missing', { query: 'note' })).status).toBe(404)
    await writeMemoryFile(id, 'Visible note')
    await mkdir(join(agentDir(id), 'data'))
    await writeFile(join(agentDir(id), 'data', 'system.db'), 'invalid')
    expect((await recall(id, { query: 'visible' })).status).toBe(500)
})

it('injects just the matching local notes into chat, including file-only notes, and only touches indexed hits', async () => {
    const a = 'automatic-owner', b = 'automatic-sibling'
    await Promise.all([a, b].map(coworker))
    const agent: LoadedAgent = {
        id: a, config: agentConfigSchema.parse({ name: a, tools: Object.fromEntries(TOOL_KEYS.map(key => [key, key === 'memory'])) }),
        install: '', soul: 'Answer briefly.', env: {}, resolved: { connection: null, model: 'test', provider: 'codex' },
    }
    const query = 'Where is the cabinet?'
    const own = await remember(a, 'Cabinet key is behind the turquoise panel.')
    const unrelated = await remember(a, 'Unrelated document is EXCLUDED-FROM-PROMPT.')
    const legacy = await writeMemoryFile(a, 'Packing instructions.\nCabinet label is papier-mâché.')
    await remember(b, 'Sibling cabinet label is PRIVATE-SIBLING.')
    const { client } = await getSystemDb(a)
    const previous = new Date(Date.now() - 3600000).toISOString()
    await client.execute({ sql: 'UPDATE memories SET last_accessed_at = ?, access_count = 3 WHERE agent_id = ?', args: [previous, a] })
    const prompt = systemPromptText(await buildSystemPrompt(agent))
    expect(prompt).not.toContain('<memory_index>')
    expect(prompt).not.toContain('EXCLUDED-FROM-PROMPT')
    expect(prompt).not.toContain('call memory_recall')
    const hits = await recallMemories(agent, query)
    expect(new Set(hits.map(hit => hit.id))).toEqual(new Set([own, legacy.id]))
    const block = recallSection(hits)
    expect(block).toContain('Cabinet label is papier-mâché.')
    expect(block).toContain('behind the turquoise panel')
    expect(block).not.toContain('PRIVATE-SIBLING')
    expect(recallSection(await recallMemories(agent, query), [{ role: 'user', content: [contextTextPart(block)] }])).toBe('')
    expect(await recallMemories(agent, 'unmatchedword')).toEqual([])
    const stats = await listMemories(a)
    const used = stats.find(row => row.id === own)!
    expect(used.accessCount).toBe(3)
    expect(Date.parse(used.lastAccessedAt!)).toBeGreaterThan(Date.parse(previous))
    expect(stats.find(row => row.id === unrelated)).toMatchObject({ accessCount: 3, lastAccessedAt: previous })
    expect(stats.some(row => row.id === legacy.id)).toBe(false)
    expect(await recallMemories({ ...agent, id: b }, 'papier-mâché')).toEqual([])
    expect(await recallMemories({ ...agent, id: 'absent' }, query)).toEqual([])
    const disabled = { ...agent, config: { ...agent.config, tools: { ...agent.config.tools, memory: false } } }
    expect(await recallMemories(disabled, query)).toEqual([])
    expect(await matches(a, { query })).toHaveLength(2)
    expect(await listMemories(a)).toEqual(stats)
})

it('recovers a staged update from the committed index and rejects a stale note or redirected file', async () => {
    const a = 'curation-owner', b = 'curation-sibling'
    await Promise.all([a, b].map(coworker))
    const original = 'Cabinet has a copper key.'
    const id = await remember(a, original)
    const other = await writeMemoryFile(b, 'Cabinet has a secret location.')
    const canonical = join(agentDir(a), 'memory', id + '.md')
    const marker = join(agentDir(a), 'memory', '.updating-' + id)
    const before = await readFile(canonical, 'utf8')
    const replacement = 'Cabinet has a silver key.'
    await writeFile(join(agentDir(a), 'memory', '.writing-' + id), '---partial')
    await writeFile(marker, before.replace(original, replacement))
    await expect(updateDesktopMemory(a, id, 'another version', 'wrong')).rejects.toMatchObject({ status: 409 })
    expect(await readFile(canonical, 'utf8')).toBe(before)
    expect(await readdir(join(agentDir(a), 'memory'))).not.toContain('.writing-' + id)
    await writeFile(marker, before)
    await expect(updateDesktopMemory(a, id, 'another version', 'wrong')).rejects.toMatchObject({ status: 409 })
    expect(await readdir(join(agentDir(a), 'memory'))).not.toContain('.updating-' + id)
    await updateDesktopMemory(a, id, original, replacement)
    const committed = await readFile(canonical, 'utf8')
    // Simulate death after committing SQLite but before replacing the old Markdown.
    await writeFile(marker, committed)
    await writeFile(canonical, before)
    expect((await recallDesktopMemory(a, 'silver', 5, { purpose: 'chat' })).map(note => note.id)).toEqual([id])
    expect(await readFile(canonical, 'utf8')).toBe(committed)
    expect(await readdir(join(agentDir(a), 'memory'))).not.toContain('.updating-' + id)
    await rename(canonical, canonical + '.saved')
    await symlink(other.path, canonical)
    await expect(updateDesktopMemory(a, id, replacement, 'wrong')).rejects.toThrow()
    expect(await recallDesktopMemory(a, 'cabinet', 5, { purpose: 'curation' })).toEqual([])
    expect(await readFile(other.path, 'utf8')).toContain('Cabinet has a secret location.')
})
