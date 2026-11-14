import type { CompanyBriefModelRef } from '@rerun/contracts'
import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    connection: { id: 'cnx_fixture-one-shot', config: { provider: 'openai' }, env: { OPENAI_API_KEY: 'offline-fixture-only' } },
    opencode: null as { workspaceId: number; revision: string } | null,
    afterAuth: () => {},
    authorize: async () => ({ ok: true }),
    replaced: false, replaceDuringAuth: false, reads: 0, modelCalls: 0, authReleases: 0,
    generate: async () => 'offline grounded result',
}))
vi.mock('../../agents/registry.js', () => ({ getAgent: async () => ({ id: 'foreman', config: { enabled: true }, env: {}, resolved: {} }) }))
vi.mock('../../agents/availability.js', () => ({ isUsable: () => true }))
vi.mock('../../connections/default.js', () => ({ readBoxDefault: async () => ({ connectionId: fixture.opencode ? 'opencode-desktop' : fixture.connection.id, model: 'fixture-model' }) }))
vi.mock('../../connections/registry.js', () => ({ findConnection: async () => {
    fixture.reads++
    if (fixture.opencode) return { id: 'opencode-desktop', config: { provider: 'opencode' }, env: {}, opencode: { ...fixture.opencode } }
    return fixture.replaced ? { ...fixture.connection } : fixture.connection
} }))
vi.mock('../../connections/cli-auth.js', () => ({ ensureCliAuth: async () => {
    if (fixture.replaceDuringAuth) fixture.replaced = true
    fixture.afterAuth()
    return () => { fixture.authReleases++ }
} }))
vi.mock('../../agents/providers.js', () => ({ modelFor: () => { fixture.modelCalls++; return { fixture: true } } }))
vi.mock('../foreman/binding.js', () => ({ readDesktopForemanBinding: () => ({ workspaceId: '1', request: fixture.authorize }) }))
vi.mock('ai', () => ({ generateText: async () => ({ text: await fixture.generate() }) }))
import { openDesktopCompanyBriefModel } from './model.js'
import { openDesktopCompanyProfileInferenceAdapter } from '../company-profile/model.js'
import { beginDesktopApiConnectionRemoval, desktopApiConnectionRemovalAvailable } from '../api-connections/admission.js'

const selection: CompanyBriefModelRef = { connectionId: 'cnx_fixture-one-shot', provider: 'openai', model: 'fixture-model', source: 'workspace', agentId: null }
const opencodeSelection = { ...selection, connectionId: 'opencode-desktop', provider: 'opencode' } as const
beforeEach(() => {
    fixture.opencode = null
    fixture.afterAuth = () => {}
    fixture.authorize = async () => ({ ok: true })
    fixture.replaced = false
    fixture.replaceDuringAuth = false
    fixture.reads = 0
    fixture.modelCalls = 0
    fixture.authReleases = 0
    fixture.generate = async () => 'offline grounded result'
})

it.each([
    ['company brief', openDesktopCompanyBriefModel],
    ['company profile', openDesktopCompanyProfileInferenceAdapter],
] as const)('keeps %s one-shot work protected until a late Stop actually settles', async (_label, open) => {
    let started!: () => void, finish!: (text: string) => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const pendingText = new Promise<string>(resolve => { finish = resolve })
    fixture.generate = async () => { started(); return pendingText }
    const stop = new AbortController()
    const pending = open().complete({ selection, prompt: 'offline facts', signal: stop.signal })
    const outcome = pending.then(text => ({ text, error: null }), error => ({ text: null, error }))
    await entered
    try {
        expect(desktopApiConnectionRemovalAvailable()).toBe(false)
        expect(beginDesktopApiConnectionRemoval()).toBeNull()
        stop.abort()
        expect(beginDesktopApiConnectionRemoval()).toBeNull()
    } finally { finish('late result must not be published') }
    const result = await outcome
    expect(result.text).toBeNull()
    expect(result.error).toMatchObject({ name: 'AbortError' })
    expect(fixture.authReleases).toBe(1)
    expect(desktopApiConnectionRemovalAvailable()).toBe(true)
})

it('refuses removal-in-progress before reading or capturing the selected credential', async () => {
    const release = beginDesktopApiConnectionRemoval()!
    try {
        await expect(openDesktopCompanyBriefModel().complete({ selection, prompt: 'offline facts', signal: new AbortController().signal })).rejects.toThrow('connection is being removed')
        expect(fixture.reads).toBe(0)
        expect(fixture.modelCalls).toBe(0)
    } finally { release() }
})

it('refuses a replaced canonical connection before starting the provider despite the same selected pair', async () => {
    fixture.replaceDuringAuth = true
    const result = await openDesktopCompanyBriefModel().complete({ selection, prompt: 'offline facts', signal: new AbortController().signal })
    expect(result).toBeNull()
    expect(fixture.modelCalls).toBe(0)
    expect(fixture.authReleases).toBe(1)
    expect(desktopApiConnectionRemovalAvailable()).toBe(true)
})

it.each([openDesktopCompanyBriefModel, openDesktopCompanyProfileInferenceAdapter])('accepts fresh projections of the same OpenCode workspace and revision', async open => {
    fixture.opencode = { workspaceId: 1, revision: 'revision-a' }
    await expect(open().complete({ selection: opencodeSelection, prompt: 'offline facts', signal: new AbortController().signal }))
        .resolves.toBe('offline grounded result')
    expect(fixture.modelCalls).toBe(1)
    expect(fixture.authReleases).toBe(1)
})

it.each([
    { workspaceId: 1, revision: 'revision-b' },
    { workspaceId: 2, revision: 'revision-a' },
])('refuses a different OpenCode snapshot before dispatch (%j)', async changed => {
    fixture.opencode = { workspaceId: 1, revision: 'revision-a' }
    fixture.afterAuth = () => { fixture.opencode = changed }
    await expect(openDesktopCompanyBriefModel().complete({ selection: opencodeSelection, prompt: 'offline facts', signal: new AbortController().signal }))
        .resolves.toBeNull()
    expect(fixture.modelCalls).toBe(0)
    expect(fixture.authReleases).toBe(1)
})

it('discards a reply if the OpenCode revision changed during inference', async () => {
    fixture.opencode = { workspaceId: 1, revision: 'revision-a' }
    fixture.generate = async () => {
        fixture.opencode = { workspaceId: 1, revision: 'revision-b' }
        return 'discard this result'
    }
    await expect(openDesktopCompanyBriefModel().complete({ selection: opencodeSelection, prompt: 'offline facts', signal: new AbortController().signal }))
        .resolves.toBeNull()
    expect(fixture.modelCalls).toBe(1)
    expect(fixture.authReleases).toBe(1)
})

it('discards a reply if the connection changes during the final conversation authority check', async () => {
    fixture.opencode = { workspaceId: 1, revision: 'revision-a' }
    fixture.authorize = async () => {
        if (fixture.modelCalls > 0) fixture.opencode = { workspaceId: 1, revision: 'revision-b' }
        return { ok: true }
    }
    const exact: CompanyBriefModelRef = {
        ...opencodeSelection, source: 'conversation', agentId: 'foreman', foremanChat: { workspaceId: '1', chatId: 'fmc_example01' },
    }
    await expect(openDesktopCompanyBriefModel().complete({ selection: exact, prompt: 'offline facts', signal: new AbortController().signal }))
        .resolves.toBeNull()
    expect(fixture.modelCalls).toBe(1)
    expect(fixture.authReleases).toBe(1)
})
