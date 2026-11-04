import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-mac-self-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const { agentDir, soulPath } = await import('../config/paths.js')
const { buildTools } = await import('../tools/registry.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const loader = await import('../agents/loader.js')
const { readAgentConfig } = loader
const { withAgentLock } = await import('../agents/lock.js')
const { createServer } = await import('../http/server.js')
const alpha = 'self-alpha', bravo = 'self-bravo'
const app = createServer()
const config = (id: string) => agentConfigSchema.parse({ name: id, description: `Tester ${id}`, tools: { desktopToolGrants: { workspaceRead: true } } })
const grant = async (id: string, grants: Record<string, boolean>) => {
    const res = await app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { desktopToolGrants: grants } }) })
    expect(res.status).toBe(200)
}
const setMaster = async (id: string, enabled: boolean) => {
    const res = await app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selfImprovement: { enabled } }) })
    expect(res.status).toBe(200)
}
const registry = async (id: string) => {
    const ctx = { agent: { id, config: await readAgentConfig(id) } } as RunContext
    return (await buildTools(ctx)).tools
}
const call = (tool: { execute?: (args: unknown, opts: unknown) => Promise<string> }, args: unknown) => tool.execute!(args, { messages: [], toolCallId: 'test' })

beforeAll(async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const id of [alpha, bravo]) {
        await mkdir(agentDir(id), { recursive: true })
        await writeAgentConfig(id, config(id))
    }
})
afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

it('exposes soul_update and verbosity_set only to the coworker that opted in', async () => {
    expect(Object.keys(await registry(alpha))).toEqual(['fs_read'])
    expect(Object.keys(await registry(bravo))).toEqual(['fs_read'])
    await grant(alpha, { selfInstruction: true, verbositySet: true })
    const alphaTools = await registry(alpha)
    expect(Object.keys(alphaTools).sort()).toEqual(['fs_read', 'soul_update', 'verbosity_set'])
    expect(Object.keys(await registry(bravo))).toEqual(['fs_read'])
})

it('withdraws the granted tools when the Improve itself master is switched off, and a stale call is refused', async () => {
    await grant(alpha, { selfInstruction: true, verbositySet: true })
    const stale = await registry(alpha)
    expect(stale.soul_update).toBeDefined()
    await setMaster(alpha, false)
    expect(Object.keys(await registry(alpha))).toEqual(['fs_read'])
    await expect(call(stale.soul_update!, { soul: '# New soul\n', reason: 'test' })).rejects.toThrow('turned off')
    await expect(call(stale.verbosity_set!, { level: 'minimal', reason: 'test' })).rejects.toThrow('turned off')
})

it('soul_update rewrites the SOUL.md file and reloads the coworker', async () => {
    await setMaster(alpha, true)
    await grant(alpha, { selfInstruction: true })
    const tools = await registry(alpha)
    const out = await call(tools.soul_update!, { soul: '  # New soul\nI am new.  \n\n', reason: 'The user redefined me.' })
    expect(out).toContain('Instructions updated')
    expect(await readFile(soulPath(alpha), 'utf8')).toBe('# New soul\nI am new.\n')
    const after = await readAgentConfig(alpha)
    expect(after.description).toBe('Tester self-alpha')
    expect(after.selfImprovement.autoMemory).toBe(true)
})

it('verbosity_set changes only the reply length, leaving the rest of the config alone', async () => {
    await setMaster(alpha, true)
    await grant(alpha, { verbositySet: true })
    const tools = await registry(alpha)
    const out = await call(tools.verbosity_set!, { level: 'minimal', reason: 'The user asked for shorter answers.' })
    expect(out).toContain('Response length set to minimal')
    const after = await readAgentConfig(alpha)
    expect(after.verbosity).toBe('minimal')
    expect(after.description).toBe('Tester self-alpha')
    expect(after.selfImprovement.autoMemory).toBe(true)
})

it('switching the master off and on preserves the autoMemory preference and the grants', async () => {
    await setMaster(alpha, true)
    await grant(alpha, { selfInstruction: true, verbositySet: true })
    await setMaster(alpha, false)
    let current = await readAgentConfig(alpha)
    expect(current.selfImprovement.enabled).toBe(false)
    expect(current.selfImprovement.autoMemory).toBe(true)
    expect(current.selfImprovement.allowSoulEdit).toBe(true)
    expect(current.tools.desktopToolGrants?.selfInstruction).toBe(true)
    await setMaster(alpha, true)
    current = await readAgentConfig(alpha)
    expect(current.selfImprovement.enabled).toBe(true)
    expect(current.selfImprovement.autoMemory).toBe(true)
    expect(Object.keys(await registry(alpha)).sort()).toEqual(['fs_read', 'soul_update', 'verbosity_set'])
})

it.each([
    ['soul_update', 'selfInstruction', 'master'],
    ['soul_update', 'selfInstruction', 'permission'],
    ['verbosity_set', 'verbositySet', 'master'],
    ['verbosity_set', 'verbositySet', 'permission'],
] as const)('%s cannot commit after a queued %s %s revocation', async (name, permission, revoke) => {
    await setMaster(alpha, true)
    await grant(alpha, { selfInstruction: true, verbositySet: true })
    const tools = await registry(alpha)
    const previousSoul = await readFile(soulPath(alpha), 'utf8')
    let current = await readAgentConfig(alpha)
    const previousVerbosity = current.verbosity

    // Snapshot the config at each grant-read invocation. This makes the old check-before-
    // lock race deterministic without depending on the OS readFile completion order.
    const configRead = vi.spyOn(loader, 'readAgentConfig').mockImplementation(async id =>
        id === alpha ? structuredClone(current) : readAgentConfig(id))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const revocation = withAgentLock(alpha, async () => {
        await gate
        if (revoke === 'master') current.selfImprovement.enabled = false
        else current.tools.desktopToolGrants = { ...current.tools.desktopToolGrants, [permission]: false }
        await writeAgentConfig(alpha, current)
    })
    const mutation = call(tools[name]!, name === 'soul_update'
        ? { soul: '# This delayed rewrite must not commit', reason: 'Queued test call' }
        : { level: previousVerbosity === 'detailed' ? 'minimal' : 'detailed', reason: 'Queued test call' })
        .then(value => ({ value, error: null }), error => ({ value: null, error }))
    try {
        release()
        await revocation
        expect((await mutation).error).toMatchObject({ message: 'This tool is turned off for this coworker.' })
        expect(await readFile(soulPath(alpha), 'utf8')).toBe(previousSoul)
        expect((await readAgentConfig(alpha)).verbosity).toBe(previousVerbosity)
    } finally {
        release()
        await Promise.allSettled([revocation, mutation])
        configRead.mockRestore()
    }
})
