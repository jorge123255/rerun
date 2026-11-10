import { afterEach, expect, it, vi } from 'vitest'
import { agentConfigSchema } from '@rerun/contracts'
import type { LoadedAgent } from '../agents/types.js'
import { buildSystemPrompt, systemPromptText } from '../agents/systemPrompt.js'

const hosted = vi.hoisted(() => ({ agent: vi.fn(async () => 'private-company-sentinel brain_write'), foreman: vi.fn(async () => 'private-foreman-sentinel brain_write') }))
vi.mock('../brain/prompt.js', () => ({ buildBrainSection: hosted.agent, buildForemanBrainSection: hosted.foreman }))
const coworker = (grant?: boolean, master = true, enabled = true, foreman = false): LoadedAgent => ({
    id: 'brain-prompt-coworker', config: agentConfigSchema.parse({ name: 'Brain prompt', enabled, kind: foreman ? 'foreman' : 'user', tools: { brain: master, memory: false, db: false, sharedDb: false, schedule: false, trigger: false, desktopToolGrants: grant === undefined ? {} : { brain: grant } } }),
    soul: 'Coworker', install: '', env: {}, resolved: { connection: null, provider: 'codex', model: 'test' },
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
it('does not read or inject company data when the explicit desktop grant is absent or disabled', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const agent of [coworker(), coworker(false), coworker(true, false), coworker(true, true, false), coworker(false, true, true, true)]) {
        const text = systemPromptText(await buildSystemPrompt(agent))
        expect(text).not.toContain('<company_brain>')
        expect(text).not.toContain('private-company-sentinel')
        expect(text).not.toContain('private-foreman-sentinel')
    }
    expect(hosted.agent).not.toHaveBeenCalled()
    expect(hosted.foreman).not.toHaveBeenCalled()
})
it('uses a review-only instruction for granted desktop tools without bypassing their live read checks', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const text = systemPromptText(await buildSystemPrompt(coworker(true)))
    expect(text).toContain('<company_brain>')
    expect(text).toContain('use brain_search and then brain_read')
    expect(text).toContain('a person reviews the exact proposal')
    expect(text).not.toContain('brain_write')
    expect(text).not.toContain('private-company-sentinel')
    expect(hosted.agent).not.toHaveBeenCalled()
})
it('preserves hosted Brain prompt behavior outside desktop', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '0')
    expect(systemPromptText(await buildSystemPrompt(coworker()))).toContain('private-company-sentinel')
    expect(systemPromptText(await buildSystemPrompt(coworker(undefined, true, true, true)))).toContain('private-foreman-sentinel')
})
it('asks for the called-coworker empty text only on a hosted chat run that names its caller', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '0')
    hosted.agent.mockClear()
    await buildSystemPrompt(coworker(), { source: 'chat' })
    expect(hosted.agent).toHaveBeenCalledWith(false)
    hosted.agent.mockClear()
    await buildSystemPrompt(coworker(), { source: 'chat', calledBy: 'engine-caller' })
    expect(hosted.agent).toHaveBeenCalledWith(true)
    for (const trigger of [{ source: 'schedule' as const, slug: 'daily', name: 'Daily' }, { source: 'trigger' as const, slug: 'hook', name: 'Hook' }]) {
        hosted.agent.mockClear()
        await buildSystemPrompt(coworker(), trigger)
        expect(hosted.agent).toHaveBeenCalledWith(false)
    }
    hosted.agent.mockClear()
    hosted.foreman.mockClear()
    await buildSystemPrompt(coworker(undefined, true, true, true), { source: 'chat', calledBy: 'engine-caller' })
    expect(hosted.foreman).toHaveBeenCalledWith()
    expect(hosted.agent).not.toHaveBeenCalled()
})
it('does not read the company brain for a desktop run, including one started by a coworker', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    hosted.agent.mockClear()
    const text = systemPromptText(await buildSystemPrompt(coworker(true), { source: 'chat', calledBy: 'engine-caller' }))
    expect(text).toContain('use brain_search and then brain_read')
    expect(text).not.toContain('ask the coworkers of the workspace')
    expect(hosted.agent).not.toHaveBeenCalled()
    expect(hosted.foreman).not.toHaveBeenCalled()
})
