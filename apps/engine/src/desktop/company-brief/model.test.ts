import { beforeEach, expect, it, vi } from 'vitest'
import type { CompanyBriefModelRef } from '@rerun/contracts'
const state = vi.hoisted(() => ({ selected: 'gpt-6.1-terra', calls: [] as unknown[], releases: 0, authority: true }))
vi.mock('../../agents/registry.js', () => ({ getAgent: async () => ({ id: 'foreman', config: { enabled: true, tools: {} }, env: { DO_NOT_BORROW: 'secret' }, soul: '', install: '', resolved: {} }) }))
vi.mock('../../agents/availability.js', () => ({ isUsable: () => true }))
vi.mock('../../connections/default.js', () => ({ readBoxDefault: async () => ({ connectionId: 'mac-chatgpt', model: state.selected }) }))
vi.mock('../../connections/registry.js', () => ({ findConnection: async () => ({ id: 'mac-chatgpt', config: { provider: 'codex' }, env: { RERUN_CHATGPT_CONNECTED: '1' } }) }))
vi.mock('../../connections/cli-auth.js', () => ({ ensureCliAuth: async () => () => { state.releases++ } }))
vi.mock('../../agents/providers.js', () => ({ modelFor: (agent: unknown) => { state.calls.push(agent); return { fixture: true } } }))
vi.mock('../foreman/binding.js', () => ({ readDesktopForemanBinding: () => ({ workspaceId: '2', request: async () => ({ ok: state.authority }) }) }))
vi.mock('ai', () => ({ generateText: async (input: unknown) => { state.calls.push(input); return { text: '{"claims":[],"unknowns":[]}' } } }))
import { openDesktopCompanyBriefModel } from './model.js'
const selection: CompanyBriefModelRef = { connectionId: 'mac-chatgpt', provider: 'codex', model: 'gpt-6.1-terra', source: 'workspace', agentId: null }
beforeEach(() => { state.selected = 'gpt-6.1-terra'; state.calls = []; state.releases = 0; state.authority = true })
it('uses only the named Codex pair through the canonical no-tool one-shot path and releases auth', async () => {
    const result = await openDesktopCompanyBriefModel().complete({ selection, prompt: 'facts', signal: new AbortController().signal })
    expect(result).toContain('claims')
    expect(state.calls[0]).toMatchObject({ env: {}, resolved: { provider: 'codex', model: 'gpt-6.1-terra', connection: { id: 'mac-chatgpt' } } })
    expect(state.calls[1]).toMatchObject({ maxRetries: 0, prompt: 'facts' })
    expect(state.calls[1]).not.toHaveProperty('tools')
    expect(state.releases).toBe(1)
})
it('refuses a changed workspace choice instead of choosing another model', async () => {
    state.selected = 'changed'
    expect(await openDesktopCompanyBriefModel().complete({ selection, prompt: 'facts', signal: new AbortController().signal })).toBeNull()
    expect(state.calls).toEqual([])
})
it('requires exact current UI authority for a Foreman conversation override', async () => {
    const exact: CompanyBriefModelRef = { ...selection, source: 'conversation', agentId: 'foreman', foremanChat: { workspaceId: '2', chatId: 'fmc_exact-0001' } }
    expect(await openDesktopCompanyBriefModel().confirm(exact)).toBe(true)
    state.authority = false
    expect(await openDesktopCompanyBriefModel().confirm(exact)).toBe(false)
    expect(state.calls).toEqual([])
})
