import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-mac-memory-write-'))
process.env.RERUN_API_KEY = ''
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { agentDir } = await import('../../config/paths.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { closeSystemDb, getSystemDb } = await import('../../db/systemDb.js')
const { ftsRecall } = await import('../../db/repos/memories.js')
const { listMemoryFiles, writeMemoryFile } = await import('../../memory/files.js')
const app = createServer()
const makeAgent = async (id: string) => {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: id }))
}
const send = (agent: string, method: string, body?: unknown, id?: string) =>
    app.request(`/agents/${agent}/memories${id ? '/' + id : ''}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('desktop memory mutations', () => {
    it('indexes exactly once without embeddings, retains fields after reopening, and deletes only the named coworker’s note', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const network = vi.fn(() => { throw Error('unexpected network request') })
        vi.stubGlobal('fetch', network)
        const a = 'mac-researcher', b = 'mac-reviewer'
        await makeAgent(a); await makeAgent(b)
        const requestId = crypto.randomUUID()
        const body = { requestId, content: '  Brass telescopes belong upstairs.  ', kind: 'fact', tags: ['desk', 'optics'] }
        const replies = await Promise.all([send(a, 'POST', body), send(a, 'POST', body)])
        for (const res of replies) {
            expect(res.status).toBe(201)
            expect(await res.json()).toEqual({ id: requestId })
        }
        expect((await send(a, 'POST', { ...body, content: 'different' })).status).toBe(409)
        expect((await send(b, 'DELETE', undefined, requestId)).status).toBe(404)
        expect((await send(b, 'POST', { ...body, content: 'Separate coworker' })).status).toBe(201)
        const keep = await send(a, 'POST', { content: 'Keep me' })
        expect(keep.status).toBe(201)
        const keepId = (await keep.json()).id
        closeSystemDb(a); closeSystemDb(b)
        const list = async (agent: string) => (await (await send(agent, 'GET')).json()).memories
        expect(await list(a)).toHaveLength(2)
        expect(await list(a)).toContainEqual(expect.objectContaining({ id: requestId, content: body.content.trim(), kind: 'fact', tags: body.tags }))
        expect((await ftsRecall(a, 'telescopes', 5)).map(hit => hit.id)).toEqual([requestId])
        expect((await send(a, 'DELETE', undefined, requestId)).status).toBe(204)
        closeSystemDb(a)
        expect(await list(a)).toEqual([expect.objectContaining({ id: keepId })])
        expect(await ftsRecall(a, 'telescopes', 5)).toEqual([])
        expect(await list(b)).toEqual([expect.objectContaining({ id: requestId, content: 'Separate coworker' })])
        expect(network).not.toHaveBeenCalled()
    })

    it('rejects blank input, unexpected fields, unsafe IDs and redirected parents before changing local data', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const owner = 'mac-owner', alias = 'mac-alias', dataAlias = 'mac-data-alias', linked = 'mac-linked'
        await Promise.all([owner, alias, dataAlias, linked].map(makeAgent))
        const other = await writeMemoryFile(owner, 'Other coworker’s note')
        const original = await readFile(other.path, 'utf8')
        for (const body of [{ content: ' \n' }, { content: 'x', requestId: '../escape' }, { content: 'x', agentId: owner }, { content: 'x', tags: [123] }]) {
            expect((await send(linked, 'POST', body)).status).toBe(400)
        }
        await symlink(join(agentDir(owner), 'memory'), join(agentDir(alias), 'memory'), 'dir')
        await mkdir(join(agentDir(owner), 'data'), { recursive: true })
        await symlink(join(agentDir(owner), 'data'), join(agentDir(dataAlias), 'data'), 'dir')
        for (const agent of [alias, dataAlias]) {
            expect((await send(agent, 'POST', { content: 'escape' })).status).toBe(403)
            expect((await send(agent, 'DELETE', undefined, other.id)).status).toBe(403)
        }
        await mkdir(join(agentDir(linked), 'memory'))
        await symlink(other.path, join(agentDir(linked), 'memory', other.id + '.md'))
        expect((await send(linked, 'DELETE', undefined, other.id)).status).toBe(403)
        expect((await send(linked, 'DELETE', undefined, 'name%2fescape')).status).toBe(400)
        expect(await readFile(other.path, 'utf8')).toBe(original)
        expect((await send('mac-missing', 'POST', { content: 'ghost' })).status).toBe(404)
    })

    it('reconciles interrupted publishes and deletes from the committed index', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const agent = 'mac-recovery'
        await makeAgent(agent)
        const id = (await (await send(agent, 'POST', { content: 'Survives restart' })).json()).id
        const root = join(agentDir(agent), 'memory')
        const current = join(root, id + '.md')
        await rename(current, join(root, '.adding-' + id))
        await writeFile(join(root, '.adding-incomplete'), 'partial write')
        closeSystemDb(agent)
        expect((await (await send(agent, 'GET')).json()).memories).toEqual([expect.objectContaining({ id, content: 'Survives restart' })])
        await rename(current, join(root, '.deleting-' + id))
        expect((await (await send(agent, 'GET')).json()).memories).toHaveLength(1)
        const { client } = await getSystemDb(agent)
        await client.execute(`CREATE TRIGGER block_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'fixture'); END`)
        expect((await send(agent, 'DELETE', undefined, id)).status).toBe(500)
        expect((await (await send(agent, 'GET')).json()).memories).toHaveLength(1)
        await client.execute('DROP TRIGGER block_delete')
        await client.execute(`CREATE TRIGGER block_index BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'fixture'); END`)
        expect((await send(agent, 'POST', { content: 'never committed' })).status).toBe(500)
        closeSystemDb(agent)
        expect((await (await send(agent, 'GET')).json()).memories).toEqual([expect.objectContaining({ id, content: 'Survives restart' })])
    })

    it('clears every note of one coworker in one pass, leaving the sibling’s notes and preferences untouched', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const network = vi.fn(() => { throw Error('unexpected network request') })
        vi.stubGlobal('fetch', network)
        const a = 'clear-owner', b = 'clear-sibling'
        await Promise.all([a, b].map(makeAgent))
        const handmade = await writeMemoryFile(a, 'Unindexed handmade note')
        const first = (await (await send(a, 'POST', { content: 'Keeps apples in season' })).json()).id
        const second = (await (await send(a, 'POST', { content: 'Prefers pears from the market' })).json()).id
        const sibling = (await (await send(b, 'POST', { content: 'Sibling note survives' })).json()).id
        const list = async (agent: string) => (await (await send(agent, 'GET')).json()).memories
        expect(await list(a)).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: handmade.id, content: 'Unindexed handmade note' }),
            expect.objectContaining({ id: first, content: 'Keeps apples in season' }),
            expect.objectContaining({ id: second, content: 'Prefers pears from the market' }),
        ]))
        const config = await readFile(join(agentDir(a), 'config.json'), 'utf8')
        closeSystemDb(a); closeSystemDb(b)
        expect((await send(a, 'DELETE')).status).toBe(204)
        closeSystemDb(a)
        expect(await list(a)).toEqual([])
        expect(await listMemoryFiles(a)).toEqual([])
        expect(await ftsRecall(a, 'apples', 5)).toEqual([])
        expect(await list(b)).toEqual([expect.objectContaining({ id: sibling, content: 'Sibling note survives' })])
        expect(await readFile(join(agentDir(a), 'config.json'), 'utf8')).toBe(config)
        expect((await send(a, 'DELETE')).status).toBe(204)
        expect(network).not.toHaveBeenCalled()
    })

    it('refuses to clear through a redirected memory directory without touching any note', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const owner = 'clear-guarded', alias = 'clear-alias'
        await Promise.all([owner, alias].map(makeAgent))
        const note = await writeMemoryFile(owner, 'Guarded note')
        await symlink(join(agentDir(owner), 'memory'), join(agentDir(alias), 'memory'), 'dir')
        expect((await send(alias, 'DELETE')).status).toBe(403)
        expect(await readFile(note.path, 'utf8')).toContain('Guarded note')
        expect((await send(owner, 'DELETE')).status).toBe(204)
        closeSystemDb(owner)
        expect(await listMemoryFiles(owner)).toEqual([])
    })

    it('names the removal marker after the listed file, so a tampered frontmatter id cannot redirect the delete', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const owner = 'clear-tampered'
        await makeAgent(owner)
        await mkdir(join(agentDir(owner), 'memory'), { recursive: true })
        await writeFile(join(agentDir(owner), 'memory', 'note.md'), `---\nid: '../../escape'\ncreatedAt: '2026-11-03T00:00:00Z'\n---\n\nHostile note\n`)
        expect((await (await send(owner, 'GET')).json()).memories).toHaveLength(1)
        expect((await send(owner, 'DELETE')).status).toBe(204)
        expect(await readdir(join(agentDir(owner), 'memory'))).toEqual([])
        expect(await readdir(agentDir(owner))).not.toContain('escape')
        expect(await listMemoryFiles(owner)).toEqual([])
    })
})
