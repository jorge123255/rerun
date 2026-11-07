import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearCachedEnvForTests } from '../../config/env.js'
import { configPath, workspaceDir } from '../../config/paths.js'
import { writeAgentConfig } from '../../agents/config-write.js'
import { desktopPrivateRegexTools } from './tools'

const root = mkdtempSync(join(tmpdir(), 'desktop-private-regex-'))
const previousDataDir = process.env.RERUN_DATA_DIR
const homeData = resolve(homedir(), '.rerun')
process.env.RERUN_DATA_DIR = root
clearCachedEnvForTests()
const agentId = 'reader'
const options = { messages: [], toolCallId: 'call-1' }
const config = (search: boolean) => ({ name: agentId, tools: { workspaceSearch: search } })
const call = async (input: { pattern: string; path?: string; maxResults?: number }, signal?: AbortSignal) => (desktopPrivateRegexTools({ agent: { id: agentId, config: await import('../../agents/loader.js').then(m => m.readAgentConfig(agentId)), abortSignal: signal } } as never).fs_search as any).execute(input, options)

beforeAll(async () => {
    const configFile = configPath(agentId)
    expect(configFile.startsWith(root)).toBe(true)
    expect(configFile.startsWith(homeData)).toBe(false)
    expect(workspaceDir(agentId).startsWith(homeData)).toBe(false)
    await mkdir(dirname(configFile), { recursive: true })
    await writeAgentConfig(agentId, config(true))
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
    await import('node:fs/promises').then(m => m.rm(root, { recursive: true, force: true }))
    if (previousDataDir === undefined) delete process.env.RERUN_DATA_DIR
    else process.env.RERUN_DATA_DIR = previousDataDir
    clearCachedEnvForTests()
})

describe('private regex semantics', () => {
    it('uses case-sensitive JavaScript regular expressions with original result shape', async () => {
        expect(await call({ pattern: 'one' })).toBe('docs/notes.md:2: one')
        expect(await call({ pattern: '^Receipt\\s+\\d+$' })).toBe('docs/notes.md:4: Receipt 42')
        expect(await call({ pattern: 'does-not-match' })).toBe('No matches.')
        expect(await call({ pattern: '[' })).toContain('Invalid regular expression:')
        expect(await call({ pattern: 'one', path: 'missing' })).toBe('Path not found: missing')
    })

    it('allows ordinary hidden assets while excluding reserved and dependency directories', async () => {
        expect(await call({ pattern: 'ordinary hidden' })).toBe('.hidden/ordinary.md:1: ordinary hidden receipt')
        expect(await call({ pattern: 'secret' })).toBe('No matches.')
    })

    it('bounds results and matching line length', async () => {
        await writeFile(join(workspaceDir(agentId), 'docs', 'many.md'), `one\none\none\n${'x'.repeat(400)}one\n`)
        expect(await call({ pattern: 'one', maxResults: 2 })).toContain('(truncated at 2 results)')
        const output = await call({ pattern: 'x{400}', maxResults: 1 })
        expect(output.split(': ').at(-1)).toHaveLength(300)
    })

    it('refuses a revoked grant without reading content', async () => {
        await writeAgentConfig(agentId, config(false))
        await expect(call({ pattern: 'one' })).rejects.toThrow('turned off')
        await writeAgentConfig(agentId, config(true))
    })

    it('cancels a pathological pattern instead of returning a successful result', async () => {
        await writeFile(join(workspaceDir(agentId), 'docs', 'pathological.md'), `${'a'.repeat(3500)}!`)
        const controller = new AbortController()
        const pending = call({ pattern: '^(a+)+$' }, controller.signal)
        const result = pending.catch(error => { throw error })
        controller.abort()
        await expect(result).rejects.toBeDefined()
    })
})
