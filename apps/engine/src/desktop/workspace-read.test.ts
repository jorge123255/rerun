import { mkdtempSync } from 'node:fs'
import { link, mkdir, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-mac-read-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const { workspaceDir } = await import('../config/paths.js')
const { buildTools } = await import('../tools/registry.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { readAgentConfig } = await import('../agents/loader.js')
const { createServer } = await import('../http/server.js')
const alpha = 'reader-alpha', bravo = 'reader-bravo'
const app = createServer()
const config = (id: string, enabled?: boolean) => agentConfigSchema.parse({ name: id, tools: { desktopWorkspaceRead: enabled } })
const grant = async (id: string, enabled: boolean) => {
    const res = await app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { desktopWorkspaceRead: enabled } }) })
    expect(res.status).toBe(200)
}
const registry = async (id: string, signal?: AbortSignal) => {
    const ctx = { agent: { id, config: await readAgentConfig(id) }, abortSignal: signal } as RunContext
    return (await buildTools(ctx)).tools
}
const reader = async (id: string, signal?: AbortSignal) => {
    const tool = (await registry(id, signal)).fs_read!
    return (path: string) => tool.execute!({ path }, { messages: [], toolCallId: 'test' })
}
beforeAll(async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const id of [alpha, bravo]) {
        await mkdir(join(workspaceDir(id), 'notes'), { recursive: true })
        await writeAgentConfig(id, config(id))
        await writeFile(join(workspaceDir(id), 'notes', 'brief.md'), `Private to ${id}`)
    }
})
afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

it('registers no tools for older coworkers, and grants precisely fs_read to the selected coworker through PATCH', async () => {
    expect(Object.keys(await registry(alpha))).toEqual([])
    expect(Object.keys(await registry(bravo))).toEqual([])
    await grant(alpha, true)
    expect(Object.keys(await registry(alpha))).toEqual(['fs_read'])
    expect(Object.keys(await registry(bravo))).toEqual([])
    const call = await reader(alpha)
    expect(await call('notes/brief.md')).toBe('Private to reader-alpha')
    await grant(bravo, true)
    expect(await (await reader(bravo))('notes/brief.md')).toBe('Private to reader-bravo')
    await grant(alpha, false)
    await expect(call('notes/brief.md')).rejects.toThrow('turned off')
    expect(Object.keys(await registry(alpha))).toEqual([])
})

it('rejects traversal, links, hidden or non-text input, missing files and directories without returning host paths', async () => {
    await grant(alpha, true)
    const root = workspaceDir(alpha), other = workspaceDir(bravo)
    const read = await reader(alpha)
    await symlink(join(other, 'notes'), join(root, 'sibling'), 'dir')
    await symlink(join(other, 'notes/brief.md'), join(root, 'linked.md'))
    await link(join(other, 'notes/brief.md'), join(root, 'alias.md'))
    await writeFile(join(root, 'invalid'), Buffer.from([0xff]))
    await writeFile(join(root, 'nul'), Buffer.from([97, 0, 98]))
    await writeFile(join(root, 'big'), Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES + 1, 65))
    for (const path of ['../../reader-bravo/workspace/notes/brief.md', '/etc/passwd', '.rerun/config', 'notes/../brief.md', 'bad\\file', 'sibling/brief.md', 'linked.md', 'alias.md', 'notes', 'missing', 'invalid', 'nul', 'big']) {
        await expect(read(path)).rejects.toThrow(/relative file path|unavailable|UTF-8 text|32 KiB/)
    }
    await writeFile(join(root, 'limit'), Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES, 65))
    expect(await read('limit')).toHaveLength(DESKTOP_ATTACHMENT_MAX_BYTES)
})

// Interleave a local writer with the first read on an already-open file descriptor.
async function duringRead(path: string, change: () => Promise<void>, check: () => Promise<void>) {
    const target = await open(path)
    const prototype = Object.getPrototypeOf(target)
    await target.close()
    const original = prototype.read
    const intercept = vi.spyOn(prototype, 'read').mockImplementationOnce(async function (this: typeof target, ...args: unknown[]) {
        await change()
        return original.apply(this, args)
    })
    try { await check() }
    finally { intercept.mockRestore() }
}

it('refuses data read through a directory moved out of the coworker workspace while open', async () => {
    await grant(alpha, true)
    const read = await reader(alpha)
    const dir = join(workspaceDir(alpha), 'moving')
    await mkdir(dir)
    await writeFile(join(dir, 'secret'), 'TEXT THAT MUST NOT ESCAPE')
    await duringRead(join(dir, 'secret'), () => rename(dir, join(workspaceDir(bravo), 'moved')),
        () => expect(read('moving/secret')).rejects.toThrow('unavailable'))
})

it('bounds a file growing after fstat, and rechecks permission when the read returns', async () => {
    await grant(alpha, true)
    const read = await reader(alpha)
    const file = join(workspaceDir(alpha), 'change')
    await writeFile(file, 'A')
    await duringRead(file, () => writeFile(file, Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES + 20, 65)),
        () => expect(read('change')).rejects.toThrow('32 KiB'))
    await writeFile(file, 'Small again')
    await duringRead(file, () => grant(alpha, false),
        () => expect(read('change')).rejects.toThrow('turned off'))
})

it('cancels before reading from an expired run', async () => {
    await grant(alpha, true)
    const stop = new AbortController()
    const read = await reader(alpha, stop.signal)
    stop.abort()
    await expect(read('notes/brief.md')).rejects.toThrow(/abort/i)
})

it('merges individual grants including legacy writes, exposes independently scoped listing and search, and refuses unknown flags', async () => {
    const id = 'workspace-grants', other = 'workspace-other'
    for (const agent of [id, other]) {
        await mkdir(join(workspaceDir(agent), 'docs'), { recursive: true })
        await writeAgentConfig(agent, config(agent))
        await writeFile(join(workspaceDir(agent), 'docs', 'brief.md'), `One\nReceipt from ${agent}\n`)
    }
    const patch = (tools: Record<string, unknown>) => app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools }) })
    expect((await patch({ desktopToolGrants: { workspaceList: true, workspaceSearch: true } })).status).toBe(200)
    expect((await patch({ desktopToolGrants: { workspaceReed: true } })).status).toBe(400)
    const list = (await registry(id)).fs_list!.execute!
    const search = (await registry(id)).fs_search!.execute!
    const options = { messages: [], toolCallId: 'fixture' }
    await writeFile(join(workspaceDir(id), '.hidden'), 'receipt confidential')
    await symlink(workspaceDir(other), join(workspaceDir(id), 'alias'))
    expect(await list({ path: '.' }, options)).toBe('docs/')
    expect(await search({ path: '.', pattern: 'Receipt', maxResults: 10 }, options)).toBe('docs/brief.md:2: Receipt from workspace-grants')
    await expect(search({ path: '../workspace-other', pattern: 'receipt', maxResults: 10 }, options)).rejects.toThrow('Use a relative directory')
    expect(Object.keys(await registry(other))).toEqual([])
    await grant(id, true)
    expect(Object.keys(await registry(id)).sort()).toEqual(['fs_list', 'fs_read', 'fs_search'])
    await patch({ desktopToolGrants: { workspaceRead: false, workspaceList: false } })
    expect((await readAgentConfig(id)).tools.desktopWorkspaceRead).toBe(false)
    expect(Object.keys(await registry(id))).toEqual(['fs_search'])
    await expect(list({ path: '.' }, options)).rejects.toThrow('turned off')
})

it('binds model note tools to one coworker, preserves retries, and refuses stale edits and deletes', async () => {
    const id = 'notes-tools', other = 'notes-other'
    for (const agent of [id, other]) {
        await mkdir(workspaceDir(agent), { recursive: true })
        await writeAgentConfig(agent, agentConfigSchema.parse({ name: agent, tools: {
            desktopToolGrants: { memoryWrite: true, memoryRecall: true, memoryDelete: true },
        } }))
    }
    const tools = await registry(id)
    expect(Object.keys(tools).sort()).toEqual(['memory_delete', 'memory_recall', 'memory_write'])
    const options = { messages: [], toolCallId: 'fixture' }
    const write = (content: string, extra = {}) => tools.memory_write!.execute!({ content, kind: 'note', tags: [], ...extra }, options)
    const result = String(await write('Brass archive'))
    expect(await write('Brass archive')).toBe(result)
    const memoryId = result.split(' ').at(-1)
    const recall = (r: typeof tools) => r.memory_recall!.execute!({ query: 'brass', limit: 5, includeDormant: false }, options)
    expect(await recall(await registry(other))).toBe('No relevant memories.')
    expect(await recall(tools)).toContain(memoryId + '] (note) Brass archive')
    await expect(write('Changed', { updateId: memoryId, expectedContent: 'Old' })).rejects.toThrow('changed')
    expect(await write('Changed', { updateId: memoryId, expectedContent: 'Brass archive' })).toBe('Updated memory ' + memoryId)
    await expect(tools.memory_delete!.execute!({ id: memoryId, expectedContent: 'Old' }, options)).rejects.toThrow('changed')
    expect(await tools.memory_delete!.execute!({ id: memoryId, expectedContent: 'Changed' }, options)).toBe('Deleted memory ' + memoryId)
    await app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { memory: false }, selfImprovement: { autoMemory: false } }) })
    expect(Object.keys(await registry(id))).toEqual(['memory_delete'])
    await expect(recall(tools)).rejects.toThrow('turned off')
    await expect(write('A new note')).rejects.toThrow('turned off')
})

it('freezes native grants until every active Codex process belonging to the coworker closes', async () => {
    const { beginDesktopCodexRun, endDesktopCodexRun } = await import('./native-grants.js')
    const id = 'native-owner', other = 'native-other'
    for (const a of [id, other]) {
        await mkdir(workspaceDir(a), { recursive: true })
        await writeAgentConfig(a, config(a))
    }
    const patch = (agent: string, flags: object) => app.request(`/agents/${agent}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { desktopCodexGrants: flags } }) })
    const signal = new AbortController().signal
    await Promise.all(['a','b'].map(runId => beginDesktopCodexRun(id, runId, signal)))
    expect((await patch(id, { webSearch: false })).status).toBe(200)
    expect((await patch(id, { webSearch: true })).status).toBe(409)
    expect((await patch(other, { webSearch: true })).status).toBe(200)
    endDesktopCodexRun(id, 'a')
    expect((await patch(id, { webSearch: true })).status).toBe(409)
    endDesktopCodexRun(id, 'b')
    expect((await patch(id, { webSearch: true })).status).toBe(200)
    expect((await beginDesktopCodexRun(id, 'fresh', signal)).tools.desktopCodexGrants).toEqual({ webSearch: true })
    endDesktopCodexRun(id, 'fresh')
    expect((await patch(id, { unverifiedExternalTool: true })).status).toBe(400)
})
