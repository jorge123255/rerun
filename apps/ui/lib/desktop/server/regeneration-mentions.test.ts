import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopCoworkerMentionContextParts } from '@rerun/contracts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ chat: vi.fn(), messages: vi.fn(), model: vi.fn(), targets: vi.fn() }))
vi.mock('@/lib/engine/client', async original => ({ ...await original<typeof import('@/lib/engine/client')>(), chat: mocks.chat, getSessionMessages: mocks.messages }))
vi.mock('./chat-model', () => ({ resolveDesktopChatModel: mocks.model, savedChoice: () => null }))
vi.mock('./setup/service', () => ({ assertDesktopSetupChatAllowed: async () => {} }))
vi.mock('./coworker-calls/targets', () => ({ desktopCoworkerCallTargets: mocks.targets }))
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, createDesktopSession, listDesktopSessions } from './store'
import { startDesktopChat } from './engine'
import type { DesktopRuntime } from './runtime'

let root: string, runtime: DesktopRuntime
let input: { agentId: string; sessionId: string; regenerateMessageId: string; requestId: string }
let accepted: { sessionId: string; runId: string } | null, loseResponse: boolean, executions: number
const text = '@Alex please review this'
const mentions = [{ targetId: 'selected-peer', token: '@Alex', start: 0, end: 5 }]
const target = { agentId: 'selected-peer', name: 'Alex', handle: null, boxName: null, enabled: true, callable: true }
const replayResponse = () => new Response(null, { status: 204, headers: { 'x-session-id': accepted!.sessionId, 'x-run-id': accepted!.runId } })

beforeEach(async () => {
    vi.resetAllMocks(); accepted = null; loseResponse = false; executions = 0
    root = await mkdtemp(join(tmpdir(), 'rerun-regeneration-mentions-'))
    runtime = { protocolVersion: 1, workspaceId: 1, dataRoot: root, launchNonce: 'test', buildId: 'test',
        app: { origin: 'http://127.0.0.1:3001', sessionToken: 'fixture-only' }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }
    const db = await openDesktopDatabase(root)
    const agent = await createDesktopAgent(db, { engineAgentId: 'engine-owner', name: 'Owner' })
    const session = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-source', title: 'Source' })
    input = { agentId: agent.id, sessionId: session.id, regenerateMessageId: 'engine-answer', requestId: crypto.randomUUID() }
    mocks.model.mockResolvedValue({ connectionId: 'selected-model-connection', model: 'selected-model' })
    mocks.targets.mockResolvedValue({ targets: [target] })
    mocks.messages.mockResolvedValue([
        { id: 'question', role: 'user', contentJson: JSON.stringify([{ type: 'text', text }, ...desktopCoworkerMentionContextParts(text, mentions)]) },
        { id: 'answer', role: 'assistant', contentJson: JSON.stringify([{ type: 'text', text: 'Original answer' }]) },
    ])
    mocks.chat.mockImplementation(async (_engine, _owner, body: { replayOnly?: boolean }) => {
        if (body.replayOnly) return accepted ? replayResponse() : Response.json({ code: 'regeneration_not_found' }, { status: 404 })
        executions++
        accepted = { sessionId: 'engine-alternate', runId: 'alternate-run' }
        if (loseResponse) throw new Error('Acknowledgement lost')
        return replayResponse()
    })
})
afterEach(async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) })

test('an accepted fork with a lost acknowledgement recovers despite the mentioned coworker disappearing', async () => {
    loseResponse = true
    await expect(startDesktopChat(runtime, input)).rejects.toThrow('Acknowledgement lost')
    expect(executions).toBe(1)
    expect(mocks.targets).toHaveBeenCalledTimes(1)
    const originalRequestId = mocks.chat.mock.calls[1][2].requestId
    mocks.targets.mockResolvedValue({ targets: [] })
    mocks.messages.mockRejectedValue(new Error('Original message read should not be needed'))
    mocks.model.mockRejectedValue(new Error('Model preparation should not be needed'))
    await closeDesktopDatabase(root)
    const recovered = await startDesktopChat(runtime, { ...input, requestId: crypto.randomUUID() })
    expect(recovered.sessionId).not.toBe(input.sessionId)
    expect(await recovered.response.text()).toBe('data: [DONE]\n\n')
    expect(mocks.chat.mock.calls.at(-1)![2]).toMatchObject({ sessionId: 'engine-source', regenerateMessageId: 'answer', requestId: originalRequestId, replayOnly: true })
    expect(mocks.targets).toHaveBeenCalledTimes(1)
    expect(mocks.messages).toHaveBeenCalledTimes(1)
    expect(mocks.model).toHaveBeenCalledTimes(1)
    expect(executions).toBe(1)
    expect(await listDesktopSessions(await openDesktopDatabase(root), input.agentId)).toHaveLength(2)
})

test('an unknown regeneration still validates saved mention IDs before any new execution', async () => {
    mocks.targets.mockResolvedValue({ targets: [{ ...target, agentId: 'another-peer-with-same-name' }] })
    await expect(startDesktopChat(runtime, input)).rejects.toMatchObject({ status: 409 })
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(mocks.chat.mock.calls[0][2]).toMatchObject({ replayOnly: true })
    expect(executions).toBe(0)
    expect(await listDesktopSessions(await openDesktopDatabase(root), input.agentId)).toHaveLength(1)
})

test('a new accepted regeneration sends only after a missing probe and successful identity validation', async () => {
    const result = await startDesktopChat(runtime, input)
    await result.response.text()
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(mocks.chat.mock.calls[0][2]).toMatchObject({ replayOnly: true })
    expect(mocks.chat.mock.calls[1][2]).not.toHaveProperty('replayOnly')
    expect(mocks.targets).toHaveBeenCalledTimes(1)
    expect(executions).toBe(1)
})

test('an ambiguous probe failure cannot fall through into another execution', async () => {
    mocks.chat.mockResolvedValue(Response.json({ error: 'Receipt unavailable' }, { status: 503 }))
    await expect(startDesktopChat(runtime, input)).rejects.toMatchObject({ status: 502 })
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(mocks.messages).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
    expect(mocks.targets).not.toHaveBeenCalled()
    expect(executions).toBe(0)
})
