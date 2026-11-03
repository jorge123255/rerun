import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-memories-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it, beforeAll, vi } = await import('vitest')
const { mkdir, symlink, writeFile } = await import('node:fs/promises')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir } = await import('../../config/paths.js')
const { writeMemoryFile } = await import('../../memory/files.js')
const { getSystemDb } = await import('../../db/systemDb.js')

describe('desktop read-only memory listing', () => {
    async function makeAgent(agentId: string) {
        await mkdir(agentDir(agentId), { recursive: true })
        await writeAgentConfig(agentId, agentConfigSchema.parse({ name: agentId }))
    }
    async function getMemories(agentId: string) {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try { return await app.request(`/agents/${agentId}/memories`) }
        finally { vi.unstubAllEnvs() }
    }
    it('reads only that coworker’s files, ignores linked files, and returns a genuine empty list', async () => {
        const first = 'desktopempty', second = 'desktopother'
        await makeAgent(first)
        await makeAgent(second)
        const other = await writeMemoryFile(second, 'Other coworker')
        const empty = await getMemories(first)
        expect(empty.status).toBe(200)
        expect(await empty.json()).toEqual({ memories: [] })
        const own = await writeMemoryFile(first, 'Own memory', 'fact', ['qa'])
        await symlink(other.path, resolve(agentDir(first), 'memory', 'link.md'))
        const res = await getMemories(first)
        expect(res.status).toBe(200)
        expect((await res.json()).memories).toEqual([expect.objectContaining({ id: own.id, content: 'Own memory', kind: 'fact', tags: ['qa'] })])
        expect((await getMemories('desktopmissing')).status).toBe(404)
    })
    it('refuses a memory directory or coworker directory redirected to another coworker', async () => {
        const first = 'desktopalias', second = 'desktoptarget'
        await makeAgent(first)
        await makeAgent(second)
        await writeMemoryFile(second, 'Hidden sibling memory')
        await symlink(agentDir(second), agentDir('desktopotheralias'), 'dir')
        await symlink(resolve(agentDir(second), 'memory'), resolve(agentDir(first), 'memory'), 'dir')
        for (const agentId of [first, 'desktopotheralias']) {
            const res = await getMemories(agentId)
            expect(res.status).toBe(403)
            expect(await res.text()).not.toContain('Hidden sibling memory')
        }
    })
    it('does not execute javascript front matter when a Mac user opens Memories', async () => {
        const agentId = 'desktopmetadata'
        await makeAgent(agentId)
        const dir = resolve(agentDir(agentId), 'memory')
        await mkdir(dir)
        await writeFile(resolve(dir, 'bad.md'), '---js\n(process.env.RERUN_MEMORY_JS_EXECUTED="yes", {id:"bad"})\n---\nHello')
        expect((await getMemories(agentId)).status).not.toBe(200)
        expect(process.env.RERUN_MEMORY_JS_EXECUTED).toBeUndefined()
    })
})

const id = 'memoryagent'
const app = createServer()

type Memory = { id: string; kind: string; tags: string[]; content: string; accessCount: number; lastAccessedAt: string | null; strength: number; status: string }

function send(method: string, path: string, body?: unknown) {
    return app.request(`/agents/${id}/memories${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
}

async function list(): Promise<Memory[]> {
    return ((await (await app.request(`/agents/${id}/memories`)).json()) as { memories: Memory[] }).memories
}

async function remember(content: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await send('POST', '', { content, ...extra })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
}

async function recall(body: Record<string, unknown>) {
    return send('POST', '/recall', body)
}

beforeAll(async () => {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'memory' }))
})

describe('agent memories over HTTP', () => {
    it('writes a note with no tags by default and lists it as active', async () => {
        const memoryId = await remember('The customer prefers invoices in euros')
        const memory = (await list()).find(m => m.id === memoryId)
        expect(memory).toMatchObject({ kind: 'note', tags: [], content: 'The customer prefers invoices in euros', accessCount: 0, status: 'active' })
        expect(memory?.strength).toBeGreaterThan(0.99)
    })

    it('keeps the kind and tags it was given', async () => {
        const memoryId = await remember('Ship on Fridays', { kind: 'preference', tags: ['release'] })
        expect((await list()).find(m => m.id === memoryId)).toMatchObject({ kind: 'preference', tags: ['release'] })
    })

    it('rejects an empty memory', async () => {
        expect((await send('POST', '', { content: '' })).status).toBe(400)
    })

    it('404s when writing to an unknown agent', async () => {
        const res = await app.request('/agents/ghost/memories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) })
        expect(res.status).toBe(404)
    })

    it('lists a memory file that never reached the index with neutral stats', async () => {
        const file = await writeMemoryFile(id, 'Written by hand', 'fact', ['manual'])
        expect((await list()).find(m => m.id === file.id)).toMatchObject({ kind: 'fact', tags: ['manual'], accessCount: 0, lastAccessedAt: null, status: 'active' })
    })

    it('recalls by keyword without reinforcing what it read', async () => {
        const memoryId = await remember('The warehouse in Lyon closes at noon on Saturdays')
        const res = await recall({ query: 'warehouse Lyon' })
        expect(res.status).toBe(200)
        const { memories } = (await res.json()) as { memories: Memory[] }
        expect(memories.map(m => m.id)).toEqual([memoryId])
        expect(memories[0].status).toBe('active')
        expect((await list()).find(m => m.id === memoryId)?.accessCount).toBe(0)
    })

    it('validates the recall query and limit', async () => {
        expect((await recall({ query: '' })).status).toBe(400)
        expect((await recall({ query: 'x', limit: 21 })).status).toBe(400)
        expect((await recall({ query: 'x', limit: 0 })).status).toBe(400)
    })

    it('hides a faded memory from recall unless dormant ones are asked for', async () => {
        const memoryId = await remember('The old office alarm code was changed')
        const { client } = await getSystemDb(id)
        await client.execute({ sql: 'UPDATE memories SET last_accessed_at = ? WHERE id = ?', args: ['2020-01-01T00:00:00.000Z', memoryId] })

        const hidden = (await (await recall({ query: 'office alarm' })).json()) as { memories: Memory[] }
        expect(hidden.memories).toEqual([])

        const shown = (await (await recall({ query: 'office alarm', includeDormant: true })).json()) as { memories: Memory[] }
        expect(shown.memories.map(m => [m.id, m.status])).toEqual([[memoryId, 'dormant']])
        expect((await list()).find(m => m.id === memoryId)?.status).toBe('dormant')
    })

    it('deletes one memory', async () => {
        const memoryId = await remember('Forget this one')
        expect((await send('DELETE', `/${memoryId}`)).status).toBe(204)
        expect((await list()).map(m => m.id)).not.toContain(memoryId)
        expect((await (await recall({ query: 'forget' })).json()) as { memories: Memory[] }).toEqual({ memories: [] })
    })

    it('answers 204 when deleting a memory that is already gone', async () => {
        expect((await send('DELETE', '/already-gone')).status).toBe(204)
    })

    it('wipes every memory', async () => {
        await remember('One more')
        expect((await send('DELETE', '')).status).toBe(204)
        expect(await list()).toEqual([])
    })
})
