import { afterEach, expect, it, vi } from 'vitest'
import { agentConfigSchema } from '@rerun/contracts'
import type { LoadedAgent } from '../../agents/types.js'
import { buildSystemPrompt, systemPromptText } from '../../agents/systemPrompt.js'
import { desktopToolInstruction, hasDesktopToolGrant } from '../tool-grants.js'

vi.mock('../../brain/prompt.js', () => ({ buildBrainSection: async () => '', buildForemanBrainSection: async () => '' }))
const off = { brain: false, memory: false, db: false, sharedDb: false, schedule: false, trigger: false }
const coworker = (config: Record<string, unknown>): LoadedAgent => ({
    id: 'repository-prompt-coworker', config: agentConfigSchema.parse({ name: 'Repository prompt', tools: off, ...config }),
    soul: 'Coworker', install: '', env: {}, resolved: { connection: null, provider: 'codex', model: 'test' },
})
afterEach(() => { vi.unstubAllEnvs() })

it('tells a coworker its repository as one short labelled fact, and only on the Mac', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const text = systemPromptText(await buildSystemPrompt(coworker({ desktopRepository: { owner: 'acme', name: 'openflix' } })))
    expect(text).toContain('<repository>')
    expect(text).toContain('You work on the GitHub repository acme/openflix (https://github.com/acme/openflix).')
    expect(text).toContain('grants no permission')
    // Naming a repository turns nothing on.
    expect(text).toContain('This coworker has no Rerun tools enabled')
    expect(text.match(/<repository>/g)).toHaveLength(1)

    for (const none of [coworker({}), coworker({ desktopRepository: null })]) expect(systemPromptText(await buildSystemPrompt(none))).not.toContain('<repository>')
    vi.stubEnv('RERUN_DESKTOP_APP', '0')
    expect(systemPromptText(await buildSystemPrompt(coworker({ desktopRepository: { owner: 'acme', name: 'openflix' } })))).not.toContain('<repository>')
})

it('Change GitHub repositories is off by default and advertises no tool of its own', () => {
    const plain = coworker({}).config
    expect(hasDesktopToolGrant(plain, 'githubWrite')).toBe(false)
    const granted = coworker({ tools: { ...off, desktopToolGrants: { githubWrite: true } } }).config
    expect(hasDesktopToolGrant(granted, 'githubWrite')).toBe(true)
    expect(desktopToolInstruction(granted)).toBe(desktopToolInstruction(plain))
})
