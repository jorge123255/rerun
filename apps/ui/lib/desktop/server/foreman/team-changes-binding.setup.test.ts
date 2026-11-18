import { beforeEach, expect, test, vi } from 'vitest'
import type { Client } from '@libsql/client'
import type { DesktopForemanBinding } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'

const ports = vi.hoisted(() => ({ agents: vi.fn(), setup: vi.fn(), inspect: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('../store', () => ({ listDesktopAgents: ports.agents }))
vi.mock('../settings', () => ({ readDesktopProviders: async () => ({ connections: [] }) }))
vi.mock('../setup/service', () => ({ observeDesktopSetup: ports.setup }))
vi.mock('./setup-coordination', () => ({ inspectChiefSetup: ports.inspect }))
const { desktopTeamWorkspace } = await import('./team-changes-binding')
const { DesktopHttpError } = await import('../auth')
const { sealTeamChanges } = await import('./team-changes')
const roles = ['Developer', 'QA tester', 'Release manager']
const people = roles.map((name, index) => ({ id: 'id-' + index, name }))
const step = { sessionId: 's', revision: 'r', stepId: 'a'.repeat(64) }
beforeEach(() => { vi.resetAllMocks(); ports.agents.mockResolvedValue(people) })
async function propose(changes: Record<string, unknown>[]) {
    const input = { summary: 'Review team setup', changes }
    const observed = await desktopTeamWorkspace({} as DesktopRuntime, {} as Client, {} as DesktopForemanBinding, input, new AbortController().signal)
    const result = sealTeamChanges(input, observed)
    if (!result.ok) throw Error(result.message)
    return result
}
test('read only named setup conversations and preserve useful answers when another contact is refused', async () => {
    ports.inspect.mockImplementation(async (_runtime, _db, _binding, name) => {
        if (name === 'QA tester') throw new DesktopHttpError(403, 'Contact unavailable.')
        return { agentId: 'id-0', state: 'awaiting_reply', step, lastMessage: 'Which platform?' }
    })
    const result = await propose(roles.slice(0, 2).map(coworker => ({ action: 'reply_setup', coworker, stepId: step.stepId, reply: 'Use iOS.' })))
    expect(ports.inspect.mock.calls.map(args => args[3])).toEqual(['Developer', 'QA tester'])
    expect(ports.setup).not.toHaveBeenCalled()
    expect(result.changes).toMatchObject([{ agentId: 'id-0', setupReply: { ...step, question: 'Which platform?', text: 'Use iOS.' } }])
    expect(result.refused).toHaveLength(1)
})
test('resumes a skipped setup on its original claim and starts one only when no claim exists', async () => {
    ports.setup.mockImplementation(async (_runtime, id) => ({
        skipped: true, pending: false, canStart: id === 'id-0', canContinue: id === 'id-1', canSkip: false, revision: id, sessionId: id === 'id-1' ? 'original' : null,
    }))
    const result = await propose([...roles.map(coworker => ({ action: 'continue_setup', coworker })), { action: 'start_setup', coworker: 'Developer' }])
    expect(result.changes).toMatchObject([{ agentId: 'id-0', setupResumeAction: 'start', setupRevision: 'id-0' }, { agentId: 'id-1', setupResumeAction: 'continue', setupRevision: 'id-1' }])
    expect(result.refused).toHaveLength(2)
    expect(ports.inspect).not.toHaveBeenCalled()
})
