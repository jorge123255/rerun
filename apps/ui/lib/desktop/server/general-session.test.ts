import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ chat: vi.fn(), request: vi.fn(), runs: vi.fn(), cancel: vi.fn(), model: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/engine/client', async original => ({
    ...await original<typeof import('@/lib/engine/client')>(),
    chat: mocks.chat, request: mocks.request, listRuns: mocks.runs, cancelRun: mocks.cancel,
}))
vi.mock('./chat-model', () => ({ resolveDesktopChatModel: mocks.model, savedChoice: () => undefined }))

import { GENERAL_ALREADY_OPEN, generalTabUid } from '../general-threads'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { startDesktopChat } from './engine'
import { writeDesktopTabs } from './session-tabs'
import { GeneralAlreadyOpenError, createDesktopAgent, createDesktopSession, findDesktopGeneralSession, listDesktopSessions } from './store'
import type { DesktopRuntime } from './runtime'

let root: string
let runtime: DesktopRuntime

beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(join(tmpdir(), 'rerun-general-session-'))
    runtime = {
        protocolVersion: 1, workspaceId: 1, dataRoot: root, launchNonce: 'general-launch', buildId: 'test',
        app: { origin: 'http://127.0.0.1:3001', sessionToken: 'fixture-session' },
        engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' },
    }
    mocks.model.mockResolvedValue({ connectionId: 'connected', model: 'picked-model' })
    mocks.runs.mockResolvedValue([])
    mocks.request.mockImplementation(async (_engine, path: string, _options, parse) => parse(path.endsWith('/setup')
        ? { required: false, prompt: '', completedAt: null, sessionId: null, pending: false, revision: 'fixture-setup' }
        : {}))
    mocks.chat.mockImplementation(async (_engine: unknown, _agent: string, body: { message?: string; sessionId?: string; desktopFirstTurn?: { sessionId: string; runId: string }; model?: string }) => new Response('data: [DONE]\n\n', {
        headers: {
            'content-type': 'text/event-stream',
            'x-session-id': body.desktopFirstTurn?.sessionId ?? body.sessionId ?? 'regular-session',
            'x-run-id': body.desktopFirstTurn?.runId ?? 'regular-run',
        },
    }))
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
})

async function coworker(name: string, engineAgentId: string) {
    const db = await openDesktopDatabase(root)
    return createDesktopAgent(db, { engineAgentId, name })
}

test('one General per coworker, and a saved chat keeps its id, title and thread kind', async () => {
    const ada = await coworker('Ada', 'engine-ada')
    const bea = await coworker('Bea', 'engine-bea')
    const db = await openDesktopDatabase(root)
    const notes = await createDesktopSession(db, { agentId: ada.id, engineSessionId: 'engine-notes', title: 'Daily notes', firstMessage: 'Keep this title' })
    expect(notes).toMatchObject({ title: 'Daily notes', kind: 'thread', firstMessage: 'Keep this title' })
    const general = await createDesktopSession(db, { agentId: ada.id, engineSessionId: 'engine-general', title: 'Hello', kind: 'general', firstMessage: 'Hello' })
    expect(general).toMatchObject({ title: 'General', kind: 'general', firstMessage: null, agentId: ada.id })
    await expect(createDesktopSession(db, { agentId: ada.id, engineSessionId: 'engine-second', title: 'Again', kind: 'general' })).rejects.toBeInstanceOf(GeneralAlreadyOpenError)
    await expect(createDesktopSession(db, { agentId: bea.id, engineSessionId: 'engine-general', title: 'Stolen', kind: 'general' })).rejects.toThrow('Engine conversation belongs to another coworker')
    const beaGeneral = await createDesktopSession(db, { agentId: bea.id, engineSessionId: 'engine-bea-general', title: 'Bea', kind: 'general' })
    expect(await findDesktopGeneralSession(db, ada.id)).toMatchObject({ id: general.id })
    expect(await findDesktopGeneralSession(db, bea.id)).toMatchObject({ id: beaGeneral.id })
    expect((await listDesktopSessions(db, ada.id)).find(session => session.id === notes.id)).toMatchObject({ title: 'Daily notes', kind: 'thread' })
    expect(await findDesktopGeneralSession(db, 'missing-coworker')).toBeNull()
})

test('concurrent first sends share one General receipt and a different first message waits', async () => {
    const ada = await coworker('Ada', 'engine-ada')
    const db = await openDesktopDatabase(root)
    const uid = generalTabUid(ada.id)
    await writeDesktopTabs(db, ada.id, { baseRevision: 0, activeIndex: 0, tabs: [{ uid, id: null }, { uid: 'thread-tab', id: null }] })
    const input = { agentId: ada.id, text: 'Hello from both windows', tabUid: uid, modelChoice: { connectionId: 'connected', model: 'picked-model' } }
    await db.execute({
        sql: `INSERT INTO desktop_tab_starts (agent_id, uid, input_hash, engine_session_id, run_id, title, model_choice, launch_nonce)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [ada.id, uid, 'different-hash', 'engine-reserved', 'run-reserved', 'Hello', 'null', 'general-launch'],
    })
    await expect(startDesktopChat(runtime, { ...input, text: 'A different opening' })).rejects.toMatchObject({ status: 409, message: GENERAL_ALREADY_OPEN })
    expect(mocks.chat).not.toHaveBeenCalled()
    await db.execute({ sql: 'DELETE FROM desktop_tab_starts WHERE agent_id = ?', args: [ada.id] })

    const [first, second] = await Promise.all([startDesktopChat(runtime, input), startDesktopChat(runtime, input)])
    expect(first.sessionId).toBe(second.sessionId)
    const turns = mocks.chat.mock.calls.map(call => call[2].desktopFirstTurn)
    expect(new Set(turns.map((turn: { sessionId: string; runId: string }) => `${turn.sessionId}:${turn.runId}`)).size).toBe(1)
    const saved = await findDesktopGeneralSession(db, ada.id)
    expect(saved).toMatchObject({ id: first.sessionId, title: 'General', kind: 'general', firstMessage: null })
    expect((await listDesktopSessions(db, ada.id)).filter(session => session.kind === 'general')).toHaveLength(1)

    mocks.chat.mockClear()
    const retry = await startDesktopChat(runtime, input)
    expect(retry.sessionId).toBe(first.sessionId)
    expect(mocks.chat).not.toHaveBeenCalled()

    const followed = await startDesktopChat(runtime, { ...input, text: 'A later note' })
    expect(followed.sessionId).toBe(first.sessionId)
    expect((await listDesktopSessions(db, ada.id)).filter(session => session.kind === 'general')).toHaveLength(1)

    const thread = await startDesktopChat(runtime, { agentId: ada.id, text: 'A separate thread', tabUid: 'thread-tab', modelChoice: input.modelChoice })
    expect(thread.sessionId).not.toBe(first.sessionId)
    expect((await listDesktopSessions(db, ada.id)).find(session => session.id === thread.sessionId)).toMatchObject({ kind: 'thread', firstMessage: 'A separate thread', title: 'A separate thread' })
    expect(mocks.chat.mock.calls.at(-1)?.[2].model).toBe('picked-model')
})
