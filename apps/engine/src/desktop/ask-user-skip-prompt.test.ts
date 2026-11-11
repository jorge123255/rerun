import { afterEach, expect, it, vi } from 'vitest'
import { agentConfigSchema, type AgentConfig } from '@rerun/contracts'
import type { LoadedAgent } from '../agents/types.js'
import { buildSystemPrompt, systemPromptText } from '../agents/systemPrompt.js'

const SKIPPED_ANSWER = 'An explicit Skip answers the question without supplying a value or granting approval. Continue the parts you can complete with what you have. State any assumption in one line and explain any part that still requires information or permission. Do not ask the skipped question again unless the user brings it up.'
const CLICK_SENDS_TEXT = 'A click only sends text, so a reply never says the user did something outside the chat (approved, clicked a button, signed in).'
const VALUE_ONLY_THE_USER_HAS = 'never when your message waits for something only the user has (a URL, an ID, a name, an email, a file, an access)'

const coworker = (grant: boolean, enabled = true, extra: Partial<AgentConfig['tools']> = {}): LoadedAgent => ({
    id: 'ask-skip-coworker',
    config: agentConfigSchema.parse({
        name: 'Ask skip', enabled, kind: 'user',
        tools: { askUser: false, requestApproval: false, suggestService: false, requestSecret: false, memory: false, db: false, sharedDb: false, schedule: false, trigger: false, skills: false, quickReplies: true, desktopToolGrants: { askUser: grant }, ...extra },
        selfImprovement: { enabled: false },
    }),
    soul: 'Coworker', install: '', env: {}, resolved: { connection: null, provider: 'codex', model: 'test' },
})

afterEach(() => vi.unstubAllEnvs())

it('tells a desktop coworker with the Ask User grant that a skipped question is already answered', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const prompt = systemPromptText(await buildSystemPrompt(coworker(true), { source: 'chat' }))
    const asking = prompt.slice(prompt.indexOf('<asking_the_user>'), prompt.indexOf('</asking_the_user>'))
    expect(asking).toContain(SKIPPED_ANSWER)
    expect(prompt).toContain('<turn_order>')
    expect(prompt.slice(prompt.indexOf('<turn_order>'), prompt.indexOf('</turn_order>'))).toContain('ask_user')
    expect(prompt).toContain(CLICK_SENDS_TEXT)
    expect(prompt).toContain(VALUE_ONLY_THE_USER_HAS)
    expect(prompt).not.toContain('<setup>')
})

it('keeps a pending desktop question out of the skip instruction when Ask User is off or the coworker is disabled', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const agent of [coworker(false), coworker(true, false)]) {
        const prompt = systemPromptText(await buildSystemPrompt(agent, { source: 'chat' }))
        expect(prompt).not.toContain(SKIPPED_ANSWER)
        expect(prompt).not.toContain('<asking_the_user>')
    }
})

it('does not treat the hosted askUser flag as permission to advertise ask_user on the Mac', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const hostedFlag = coworker(false, true, { askUser: true })
    const prompt = systemPromptText(await buildSystemPrompt(hostedFlag, { source: 'chat' }))
    expect(prompt).not.toContain(SKIPPED_ANSWER)
    expect(prompt).not.toContain('<asking_the_user>')
})

it('keeps the skip instruction for a hosted coworker whose ask_user tool is on, and for desktop setup copy', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '0')
    const hosted = coworker(false, true, { askUser: true })
    expect(systemPromptText(await buildSystemPrompt(hosted, { source: 'chat' }))).toContain(SKIPPED_ANSWER)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const setup = coworker(true)
    setup.install = 'Install this coworker.'
    setup.config = agentConfigSchema.parse({ ...setup.config, setup: { required: true, prompt: 'Install this coworker.', completedAt: null, sessionId: null } })
    const prompt = systemPromptText(await buildSystemPrompt(setup, { source: 'chat', calledBy: 'synthetic-caller' }))
    const setupText = prompt.slice(prompt.indexOf('<setup>'), prompt.indexOf('</setup>'))
    expect(setupText).toContain('If the user explicitly skips an optional app, continue with the agreed scope and the tools already available.')
    expect(setupText).toContain('keep setup pending. Use the granted request tools and wait for their saved outcomes.')
    expect(prompt.slice(prompt.indexOf('<asking_the_user>'), prompt.indexOf('</asking_the_user>'))).toContain(SKIPPED_ANSWER)
    expect(prompt).toContain('Answer the calling coworker from the context you already have')
    expect(prompt).not.toContain('synthetic-caller')
})

it('leaves quick-reply click limits out when that block is not offered', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const prompt = systemPromptText(await buildSystemPrompt(coworker(true, true, { quickReplies: false }), { source: 'chat' }))
    expect(prompt).toContain(SKIPPED_ANSWER)
    expect(prompt).not.toContain(CLICK_SENDS_TEXT)
    expect(prompt).not.toContain('<quick_replies>')
})


it('keeps delegated children out of the question prompt and preserves the Foreman setting', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const child = coworker(true)
    child.config = agentConfigSchema.parse({ ...child.config, ephemeral: true })
    expect(systemPromptText(await buildSystemPrompt(child, { source: 'chat' }))).not.toContain(SKIPPED_ANSWER)
    const foreman = coworker(false, true, { askUser: true })
    foreman.config = agentConfigSchema.parse({ ...foreman.config, kind: 'foreman' })
    expect(systemPromptText(await buildSystemPrompt(foreman, { source: 'chat' }))).toContain(SKIPPED_ANSWER)
})
