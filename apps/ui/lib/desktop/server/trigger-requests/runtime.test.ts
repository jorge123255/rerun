import type { Client } from '@libsql/client'
import { describe, expect, it, vi, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ run: vi.fn(), tools: vi.fn(), runtime: vi.fn(), agent: vi.fn(), session: vi.fn(), form: vi.fn(), permission: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ getRun: mocks.run, getRunTools: mocks.tools }))
vi.mock('../runtime', () => ({ readDesktopRuntime: mocks.runtime }))
vi.mock('../settings', () => ({ engineOf: () => ({ origin: 'http://127.0.0.1:1', apiKey: 'test-only' }) }))
vi.mock('../store', () => ({ findDesktopAgent: mocks.agent, findDesktopSession: mocks.session }))
vi.mock('../coworker-delete', () => ({ assertCoworkerNotDeleting: async () => {} }))
vi.mock('../triggers/binding', () => ({ authorizeDesktopTriggers: mocks.permission, authorizeDesktopTriggersBasic: async () => {} }))
vi.mock('./canonical', () => ({
    MissingTriggerRequestAuthority: class extends Error {},
    readCanonicalTriggerForm: mocks.form, invokeCanonicalTriggerDecision: vi.fn(), readCanonicalTriggerReceipt: vi.fn(),
}))
import { createDesktopTriggerRequests } from './runtime'
import { testTriggerLink as link, testTriggerView as view } from '../../trigger-requests/fixtures.test-support'
import type { DesktopRuntime } from '../runtime'
import type { TriggerRequestRootBindings } from './canonical'
import type { TriggerRequestJournal } from './journal'
const runtime = { protocolVersion: 1, launchNonce: 'launch-1', buildId: 'source-only-test', workspaceId: 1, dataRoot: '/test-only', app: { origin: 'http://127.0.0.1:1', sessionToken: 'test-only'.repeat(4) }, engine: { origin: 'http://127.0.0.1:2', apiKey: 'test-only' } } as DesktopRuntime
function setup() {
    const root: TriggerRequestRootBindings = {
        workspaceIdentity: link.workspaceId, resolveSessionSource: async () => ({ kind: 'trigger', target: link }),
        readDelivery: async () => ({ eventId: link.eventId, attemptFingerprint: null, localAgentId: link.agentId, engineAgentId: link.engineAgentId, slug: link.slug,
            triggerName: 'Arithmetic', method: 'POST', receivedAt: '2026-11-05T20:00:00-06:00', status: 'needs-input', localSessionId: link.sessionId,
            engineSessionId: link.engineSessionId, runId: link.triggerRunId, revision: 'revision-1', error: null, payloadBytes: 16, truncated: false, capturedPayload: false }),
        withDecisionClaim: async (_link, work) => work(), assertCurrentRequestPermission: async () => {}, stop: async () => {}, stopReceipt: async () => 'unknown',
    }
    const journal = { list: vi.fn(async () => []), publish: vi.fn(), get: vi.fn() } as unknown as TriggerRequestJournal
    return { root, journal, service: createDesktopTriggerRequests(runtime, {} as Client, root, journal) }
}
beforeEach(() => {
    vi.clearAllMocks()
    mocks.runtime.mockResolvedValue(runtime)
    mocks.agent.mockResolvedValue({ id: link.agentId, workspaceId: 1, engineAgentId: link.engineAgentId, enabled: true })
    mocks.session.mockResolvedValue({ id: link.sessionId, agentId: link.agentId, engineSessionId: link.engineSessionId })
    mocks.run.mockResolvedValue({ id: link.triggerRunId, agentId: link.engineAgentId, sessionId: link.engineSessionId, triggerSource: 'trigger', triggerSlug: link.slug, status: 'done' })
    mocks.tools.mockResolvedValue([{ runId: link.triggerRunId, agentId: link.engineAgentId, sessionId: link.engineSessionId, toolCallId: link.toolCallId, toolName: 'ask_user', isError: 0 }])
    mocks.form.mockResolvedValue(view.request)
    mocks.permission.mockResolvedValue(undefined)
})
describe('actual webhook run ownership', () => {
    it('discovery is read-only and attributes the exact tool call to the original run', async () => {
        const f = setup(), result = await f.service.discover(link)
        expect(result?.link).toMatchObject({ eventId: link.eventId, sessionId: link.sessionId, sourceRunId: link.triggerRunId, toolCallId: link.toolCallId })
        expect(f.journal.publish).not.toHaveBeenCalled()
    })
    it('refuses a private sibling chat or copied coworker even with the same tool call ID', async () => {
        const f = setup()
        mocks.tools.mockResolvedValue([{ runId: link.triggerRunId, agentId: 'copy-agent', sessionId: 'private-chat', toolCallId: link.toolCallId, toolName: 'ask_user', isError: 0 }])
        await expect(f.service.discover(link)).rejects.toThrow('not from this exact webhook')
        expect(f.journal.publish).not.toHaveBeenCalled()
    })
    it('does not follow arbitrary dashboard runs without an accepted linkage receipt', async () => {
        const f = setup(); mocks.tools.mockResolvedValue([])
        await expect(f.service.discover(link)).rejects.toThrow('not from this exact webhook')
        expect(mocks.run).toHaveBeenCalledWith(expect.anything(), link.engineAgentId, link.triggerRunId, expect.anything())
    })
    it('origin/launch changes reject stale callbacks without losing durable IDs', async () => {
        const f = setup(); mocks.runtime.mockResolvedValue({ ...runtime, launchNonce: 'launch-2' })
        await expect(f.service.discover(link)).rejects.toThrow('restarted')
        expect(mocks.tools).not.toHaveBeenCalled()
    })
    it('missing source lookup cannot quietly fall through to ordinary-chat authority', async () => {
        const f = setup(); f.root.resolveSessionSource = async () => ({ kind: 'unavailable' })
        await expect(f.service.captureForSession(link.sessionId)).rejects.toThrow('source identity is unavailable')
        expect(f.journal.publish).not.toHaveBeenCalled()
    })
    it('construction refuses absent required authorities rather than installing no-op success callbacks', () => {
        const f = setup()
        expect(() => createDesktopTriggerRequests(runtime, {} as Client, { ...f.root, withDecisionClaim: undefined } as unknown as TriggerRequestRootBindings, f.journal)).toThrow('withDecisionClaim')
    })
})
