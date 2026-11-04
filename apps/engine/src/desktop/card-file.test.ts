import { mkdtempSync } from 'node:fs'
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { CARD_MAX_FILES, DESKTOP_ATTACHMENT_MAX_BYTES, fileCardSchema } from '@rerun/contracts'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-mac-card-file-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const { workspaceDir } = await import('../config/paths.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { readAgentConfig } = await import('../agents/loader.js')
const { buildTools } = await import('../tools/registry.js')
const { createServer } = await import('../http/server.js')
const alpha = 'cards-alpha', bravo = 'cards-bravo'
const app = createServer()
const options = { messages: [], toolCallId: 'card-test' }

const config = (id: string) => agentConfigSchema.parse({ name: id, tools: { desktopToolGrants: { cardFile: false } } })
const grant = async (id: string, enabled: boolean) => {
    const response = await app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { desktopToolGrants: { cardFile: enabled } } }) })
    expect(response.status).toBe(200)
}
const registry = async (id: string, signal?: AbortSignal) => {
    const ctx = { agent: { id, config: await readAgentConfig(id) }, abortSignal: signal } as RunContext
    return (await buildTools(ctx)).tools
}
const toolFor = async (id: string, signal?: AbortSignal) => (await registry(id, signal)).card_file!
const show = async (tool: Awaited<ReturnType<typeof toolFor>>, path: string, scope?: 'agent' | 'shared') =>
    String(await tool.execute!({ files: [{ path, ...(scope && { scope }) }] }, options))

beforeAll(async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const id of [alpha, bravo]) {
        await mkdir(join(workspaceDir(id), 'reports'), { recursive: true })
        await writeAgentConfig(id, config(id))
        await writeFile(join(workspaceDir(id), 'reports', 'summary.md'), 'Summary')
        await writeFile(join(workspaceDir(id), 'reports', 'notes.txt'), 'Notes')
    }
})
afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

it('starts off, then shows only the granted coworker’s existing text file', async () => {
    expect((await registry(alpha)).card_file).toBeUndefined()
    expect((await registry(bravo)).card_file).toBeUndefined()
    await grant(alpha, true)
    expect((await registry(alpha)).card_file).toBeDefined()
    expect((await registry(bravo)).card_file).toBeUndefined()
    const tool = await toolFor(alpha)
    const result = await show(tool, 'reports/summary.md')
    expect(fileCardSchema.parse(JSON.parse(result))).toEqual({
        kind: 'file',
        files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }],
    })
    expect((await registry(alpha)).card_file!.description).not.toContain('shared space')
})

it('refuses shared, foreign, hidden, linked, directory, unsupported and oversized paths without a host path', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const root = workspaceDir(alpha), other = workspaceDir(bravo)
    await symlink(join(other, 'reports', 'summary.md'), join(root, 'linked.md'))
    await link(join(other, 'reports', 'summary.md'), join(root, 'alias.md'))
    await mkdir(join(root, 'folder.md'))
    await writeFile(join(root, 'big.md'), Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES + 1, 65))
    const cases: [string, 'agent' | 'shared', RegExp][] = [
        ['reports/summary.md', 'shared', /Shared files are not available/],
        ['/etc/passwd.md', 'agent', /relative .* path/],
        ['../cards-bravo/workspace/reports/summary.md', 'agent', /relative .* path/],
        ['.secret/summary.md', 'agent', /relative .* path/],
        ['reports\\summary.md', 'agent', /relative .* path/],
        ['linked.md', 'agent', /unavailable/],
        ['alias.md', 'agent', /unavailable/],
        ['folder.md', 'agent', /folder, not a file/],
        ['reports/image.png', 'agent', /relative .* path/],
        ['big.md', 'agent', /32 KiB/],
        ['missing.md', 'agent', /unavailable/],
    ]
    for (const [path, scope, message] of cases) {
        const result = await show(tool, path, scope)
        expect(result, path).toContain('nothing was shown')
        expect(result, path).toMatch(message)
        expect(result, path).not.toContain(root)
        expect(result, path).not.toContain(other)
        expect(result, path).not.toContain('kind')
    }
})

it('shows nothing when one file of a multi-file card is missing', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const result = String(await tool.execute!({ files: [
        { path: 'reports/summary.md' }, { path: 'reports/missing.md' }, { path: 'reports/notes.txt' },
    ] }, options))
    expect(result).toContain('nothing was shown')
    expect(result).toContain('reports/missing.md')
    expect(result).not.toContain('summary.md:')
    expect(result).not.toContain('kind')
})

it('bounds the file count and accepts the JSON-string input the model sometimes sends', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const schema = tool.inputSchema as { safeParse: (value: unknown) => { success: boolean } }
    const files = Array.from({ length: CARD_MAX_FILES }, (_, index) => ({ path: `reports/${index}.md` }))
    expect(schema.safeParse({ files }).success).toBe(true)
    expect(schema.safeParse({ files: [...files, { path: 'reports/too-many.md' }] }).success).toBe(false)
    expect(schema.safeParse({ files: JSON.stringify([{ path: 'reports/summary.md' }]) }).success).toBe(true)
})

it('rechecks the current grant and the coworker’s enabled state before drawing a cached card', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    await grant(alpha, false)
    await expect(tool.execute!({ files: [{ path: 'reports/summary.md' }] }, options)).rejects.toThrow(/turned off/)
    await grant(alpha, true)
    await app.request(`/agents/${alpha}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    await expect(tool.execute!({ files: [{ path: 'reports/summary.md' }] }, options)).rejects.toThrow(/turned off/)
    await app.request(`/agents/${alpha}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
})

it('stops a card run that was cancelled', async () => {
    await grant(alpha, true)
    const controller = new AbortController()
    const tool = await toolFor(alpha, controller.signal)
    controller.abort(new Error('Reply stopped'))
    await expect(tool.execute!({ files: [{ path: 'reports/summary.md' }] }, options)).rejects.toThrow(/Reply stopped/)
})

it('points ask_user at card_file only when the file-card grant is on', async () => {
    await grant(alpha, true)
    const response = await app.request(`/agents/${alpha}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { desktopToolGrants: { askUser: true } } }) })
    expect(response.status).toBe(200)
    const tools = await registry(alpha)
    expect(tools.card_file).toBeDefined()
    expect(tools.ask_user?.description).toContain('card_file')
})

it('accepts an absolute path only when it resolves inside the granted workspace', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const inside = join(workspaceDir(alpha), 'reports', 'summary.md')
    const shown = fileCardSchema.parse(JSON.parse(await show(tool, inside)))
    expect(shown.files[0]).toEqual({ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' })
    const foreign = await show(tool, join(workspaceDir(bravo), 'reports', 'summary.md'))
    expect(foreign).toContain('nothing was shown')
    expect(foreign).toMatch(/relative .* path/)
})
