import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { agentConfigSchema, type LoadedAgent } from '../../agents/types.js'
import type { RunContext } from '../../runtime/context.js'

const hooks = vi.hoisted(() => ({ claim: 'child-run' as string | undefined, fetch: vi.fn() }))
vi.mock('../../config/paths.js', () => ({ workspaceDir: (id: string) => `/private-fixture/${id}/workspace` }))
vi.mock('../../runtime/run-control.js', () => ({ sessionClaim: () => hooks.claim ? { runId: hooks.claim } : undefined }))
vi.mock('../web-fetch/index.js', async () => { const { z } = await import('zod'); return { executeWebFetch: hooks.fetch, webFetchDescription: 'Fetch a public page', webFetchInputSchema: z.object({ url: z.string() }) } })
import { desktopDelegationChildTools, desktopDelegationCodexCwd, registerDelegationChild } from './child-scope.js'

let releases: (() => void)[]
beforeEach(() => { hooks.claim = 'child-run'; hooks.fetch.mockReset().mockResolvedValue('public page'); releases = [] })
afterEach(() => { for (const close of releases) close() })
function agent(): LoadedAgent {
    return { id: 'private-delegate', config: agentConfigSchema.parse({ ephemeral: true, enabled: true, name: 'Task' }), soul: 'explicit isolated task', install: '', env: {}, resolved: { connection: null, provider: 'codex', model: 'test-model' } }
}
function register(authorize: (name: string) => Promise<void> = async () => {}) {
    const child = agent(), controller = new AbortController()
    const scope = registerDelegationChild({ agent: child, sessionId: 'child-chat', runId: null, signal: controller.signal, tools: ['web_fetch'], authorize })
    releases.push(scope.close); scope.runCreated('child-run')
    const context = { agent: child, sessionId: 'child-chat', runId: 'child-run', abortSignal: controller.signal } as RunContext
    return { child, context, scope, controller }
}
async function execute(context: RunContext) {
    const binding = (await desktopDelegationChildTools(context))!
    expect(Object.keys(binding.tools)).toEqual(['web_fetch'])
    const run = binding.tools.web_fetch!.execute as (input: { url: string }, options: { toolCallId: string; messages: [] }) => Promise<unknown>
    return run({ url: 'https://example.org/' }, { toolCallId: 'child-fetch', messages: [] })
}

test('uses the exact private cwd and gives cloned loaded views only the approved fetch tool', async () => {
    const { child, context } = register()
    const cloned = structuredClone(child)
    expect(desktopDelegationCodexCwd(cloned)).toBe('/private-fixture/private-delegate/workspace')
    expect(await execute({ ...context, agent: cloned })).toBe('public page')
    expect(hooks.fetch).toHaveBeenCalledTimes(1)
})

test('a fresh ephemeral flag cannot authorize a private provider or tool scope', async () => {
    expect(() => desktopDelegationCodexCwd(agent())).toThrow('Unowned')
    await expect(desktopDelegationChildTools({ agent: agent() } as RunContext)).rejects.toThrow('Unowned')
})

test.each(['provider', 'instructions', 'credentials', 'install'] as const)('refuses a changed %s before private tool construction', async kind => {
    const { child, context } = register(); const changed = structuredClone(child)
    if (kind === 'provider') changed.resolved.provider = 'openai'
    if (kind === 'instructions') changed.soul = 'parent secret instructions'
    if (kind === 'credentials') changed.env = { PRIVATE_KEY: 'private-key-fixture' }
    if (kind === 'install') changed.install = 'new setup instructions'
    await expect(desktopDelegationChildTools({ ...context, agent: changed })).rejects.toThrow('scope changed')
    expect(hooks.fetch).not.toHaveBeenCalled()
})

test('rechecks the exact run after awaited parent authorization before the network fetch', async () => {
    const { context } = register(async () => { hooks.claim = 'replacement-run' })
    await expect(execute(context)).rejects.toThrow('run changed')
    expect(hooks.fetch).not.toHaveBeenCalled()
})

test('a closed scope cannot continue an already constructed tool', async () => {
    const { context, scope } = register()
    const binding = (await desktopDelegationChildTools(context))!
    scope.close()
    const run = binding.tools.web_fetch!.execute as (input: { url: string }, options: { toolCallId: string; messages: [] }) => Promise<unknown>
    await expect(run({ url: 'https://example.org' }, { toolCallId: 'fetch', messages: [] })).rejects.toThrow('scope changed')
    expect(hooks.fetch).not.toHaveBeenCalled()
})

test('revocation during fetch cannot return its result to a stale child', async () => {
    const { context, controller } = register()
    hooks.fetch.mockImplementationOnce(async () => { controller.abort(); return 'withheld result' })
    await expect(execute(context)).rejects.toThrow()
    expect(hooks.fetch).toHaveBeenCalledTimes(1)
})
