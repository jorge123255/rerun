import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { agentConfigSchema } from '../../agents/types.js'
import { clearCachedEnvForTests } from '../../config/env.js'
import { configPath, workspaceDir } from '../../config/paths.js'
import { writeAgentConfig } from '../../agents/config-write.js'
import type { RunContext } from '../../runtime/context.js'
import { desktopPrivateRegexTools } from './tools.js'

const root = mkdtempSync(join(tmpdir(), 'desktop-private-regex-'))
const previousDataDir = process.env.RERUN_DATA_DIR
const homeData = resolve(homedir(), '.rerun')
process.env.RERUN_DATA_DIR = root
clearCachedEnvForTests()
const agentId = 'reader'
const options = { messages: [], toolCallId: 'call-1' }
const config = (workspaceSearch: boolean) => agentConfigSchema.parse({
    name: agentId,
    enabled: true,
    tools: { desktopToolGrants: { workspaceSearch } },
})
const grantedConfig = config(true)
const call = async (input: { pattern: string; path?: string; maxResults?: number }, abortSignal?: AbortSignal) => {
    const ctx = { agent: { id: agentId, config: grantedConfig }, abortSignal } as RunContext
    const tool = desktopPrivateRegexTools(ctx).fs_search
    return tool.execute!((tool.inputSchema as z.ZodType).parse(input), options)
}

beforeAll(async () => {
    const configFile = configPath(agentId)
    expect(configFile).toBe(join(root, 'agents', agentId, 'config.json'))
    expect(workspaceDir(agentId)).toBe(join(dirname(configFile), 'workspace'))
    expect(root === homeData || root.startsWith(homeData + '/')).toBe(false)
    await mkdir(dirname(configFile), { recursive: true })
    await writeAgentConfig(agentId, grantedConfig)
    await mkdir(join(workspaceDir(agentId), 'docs'), { recursive: true })
    await mkdir(join(workspaceDir(agentId), '.hidden'), { recursive: true })
    await mkdir(join(workspaceDir(agentId), 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(workspaceDir(agentId), '.git'), { recursive: true })
    await mkdir(join(workspaceDir(agentId), '.rerun'), { recursive: true })
    await mkdir(join(workspaceDir(agentId), 'nested', '.rerun-skill'), { recursive: true })
    await writeFile(join(workspaceDir(agentId), 'docs', 'notes.md'), 'One\none\nONE\nReceipt 42\n')
    await writeFile(join(workspaceDir(agentId), '.hidden', 'ordinary.md'), 'ordinary hidden receipt\n')
    await writeFile(join(workspaceDir(agentId), 'node_modules', 'pkg', 'secret.md'), 'secret receipt\n')
    await writeFile(join(workspaceDir(agentId), '.git', 'secret.md'), 'secret receipt\n')
    await writeFile(join(workspaceDir(agentId), '.rerun', 'secret.md'), 'secret receipt\n')
    await writeFile(join(workspaceDir(agentId), 'nested', '.rerun-skill', 'secret.md'), 'secret receipt\n')
})
afterAll(async () => {
    try {
        await rm(root, { recursive: true, force: true })
    } finally {
        if (previousDataDir === undefined) delete process.env.RERUN_DATA_DIR
        else process.env.RERUN_DATA_DIR = previousDataDir
        clearCachedEnvForTests()
    }
})

describe('private regex semantics', () => {
    it('uses case-sensitive JavaScript regular expressions with original result shape', async () => {
        expect(await call({ pattern: 'one' })).toBe('docs/notes.md:2: one')
        expect(await call({ pattern: '^Receipt\\s+\\d+$' })).toBe('docs/notes.md:4: Receipt 42')
        expect(await call({ pattern: 'does-not-match' })).toBe('No matches.')
        expect(await call({ pattern: '[' })).toContain('Invalid regular expression:')
        expect(await call({ pattern: 'one', path: 'missing' })).toBe('Path not found: missing')
    })

    it('refuses absolute paths and traversal to an existing directory outside the workspace', async () => {
        const outside = join(dirname(workspaceDir(agentId)), 'outside')
        await mkdir(outside)
        await writeFile(join(outside, 'notes.md'), 'one\n')
        await expect(call({ pattern: 'one', path: outside })).rejects.toThrow('Use a relative directory')
        await expect(call({ pattern: 'one', path: '../outside' })).rejects.toThrow('Use a relative directory')
    })

    it('allows ordinary hidden assets while excluding reserved and dependency directories', async () => {
        expect(await call({ pattern: 'ordinary hidden' })).toBe('.hidden/ordinary.md:1: ordinary hidden receipt')
        expect(await call({ pattern: 'secret' })).toBe('No matches.')
    })

    it('bounds results and matching line length', async () => {
        await writeFile(join(workspaceDir(agentId), 'docs', 'many.md'), `one\none\none\n${'x'.repeat(400)}one\n`)
        expect(await call({ pattern: 'one', maxResults: 2 })).toContain('(truncated at 2 results)')
        expect(await call({ pattern: 'x{400}', maxResults: 1 })).toBe(
            `docs/many.md:4: ${'x'.repeat(300)}\n(truncated at 1 results)`,
        )
    })

    it('refuses a revoked grant without reading content', async () => {
        await writeAgentConfig(agentId, config(false))
        try {
            await expect(call({ pattern: 'one' })).rejects.toThrow('turned off')
            await expect(call({ pattern: 'one', path: 'missing' })).rejects.toThrow('turned off')
        } finally {
            await writeAgentConfig(agentId, grantedConfig)
        }
    })

    it('rejects an in-flight pathological search with the supplied cancellation reason', async () => {
        const path = 'slow'
        const pattern = '^(a+)+$'
        const line = `${'a'.repeat(3500)}!`
        await mkdir(join(workspaceDir(agentId), path))
        await writeFile(join(workspaceDir(agentId), path, 'pathological.md'), line)
        const controller = new AbortController()
        const reason = new DOMException('Stopped private search', 'AbortError')
        const postMessage = Worker.prototype.postMessage
        const dispatch = vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(function (this: Worker, message, transferList) {
            postMessage.call(this, message, transferList)
            controller.abort(reason)
        })
        try {
            await expect(call({ pattern, path }, controller.signal)).rejects.toBe(reason)
            expect(dispatch).toHaveBeenCalledExactlyOnceWith({ lines: [line], pattern, max: 200 })
        } finally {
            dispatch.mockRestore()
        }
    })
})
