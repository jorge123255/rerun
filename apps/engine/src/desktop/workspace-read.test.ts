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
