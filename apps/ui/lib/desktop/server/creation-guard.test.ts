import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({chat: vi.fn(), request: vi.fn(), patch: vi.fn(), get: vi.fn(), model: vi.fn(), runtime: vi.fn()}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/engine/client', async original => ({...await original<typeof import('@/lib/engine/client')>(),
    chat: mocks.chat, request: mocks.request, patchAgent: mocks.patch, getAgent: mocks.get}))
vi.mock('./chat-model', () => ({resolveDesktopChatModel: mocks.model, savedChoice: () => undefined}))
vi.mock('./runtime', () => ({readDesktopRuntime: mocks.runtime}))
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, findDesktopAgent, listDesktopSessions } from './store'
import { assertDesktopCreationSettled, desktopCreationPendingMessage } from './creation-guard'
import { writeDesktopTabs } from './session-tabs'
import { deleteDesktopCoworker } from './coworker-delete'
import { renameDesktopCoworker } from './coworker-rename'
import { setDesktopCoworkerEnabled } from './coworker-enabled'
import { startDesktopChat } from './engine'
import { withRosterWrite } from './roster-writes'
import type { DesktopRuntime } from './runtime'
import { POST as publicChat } from '@/app/api/desktop/chat/route'

const requestId = 'f66311e8-b9fd-4d41-ab11-278537046dcc', text = 'Review the latest customer notes.'
let root: string, agentId: string, peerId: string, runtime: DesktopRuntime
let db: Awaited<ReturnType<typeof openDesktopDatabase>>
const engine = {baseUrl: 'http://127.0.0.1:9', apiKey: 'unused'}
const tabs = {baseRevision: 1, activeIndex: 0, tabs: [{uid: 'replacement', id: null}]}
async function receipt(phase: 'reserved' | 'created' | 'started' = 'created') {
    await db.execute({sql: `INSERT INTO desktop_creations(request_id,intent,agent_id,config,space_id,board_col,board_row,phase,created_at)
        VALUES(?,?,?,'{}','fixture-box',0,0,?,?)`, args: [requestId, JSON.stringify({requestId, name: 'Owner', kickoff: text}), agentId, phase, new Date().toISOString()]})
}
beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), 'rerun-creation-guard-'))
    db = await openDesktopDatabase(root)
    agentId = (await createDesktopAgent(db, {engineAgentId: 'engine-owner', name: 'Owner'})).id
    peerId = (await createDesktopAgent(db, {engineAgentId: 'engine-peer', name: 'Peer'})).id
    await writeDesktopTabs(db, agentId, {baseRevision: 0, activeIndex: 0, tabs: [{uid: requestId, id: null}]})
    runtime = {protocolVersion: 1, workspaceId: 1, dataRoot: root, launchNonce: 'guard-launch', buildId: 'test',
        app: {origin: 'http://127.0.0.1:3001', sessionToken: 'fixture-session'}, engine: {origin: 'http://127.0.0.1:9', apiKey: 'unused'}}
    mocks.runtime.mockResolvedValue(runtime)
    mocks.model.mockResolvedValue({connectionId: 'connected', model: 'picked'})
    mocks.chat.mockImplementation(async (_engine: unknown, _agent: string, body: {desktopFirstTurn?: {sessionId: string; runId: string}}) => new Response('data: [DONE]\n\n', {
        headers: {'content-type': 'text/event-stream', 'x-session-id': body.desktopFirstTurn?.sessionId ?? 'regular-session', 'x-run-id': body.desktopFirstTurn?.runId ?? 'regular-run'},
    }))
    mocks.get.mockResolvedValue({id: 'engine-owner', config: {name: 'owner', displayName: 'Owner', enabled: true}, soul: ''})
    mocks.request.mockImplementation(async (_engine, path, _options, parse) => parse(path.endsWith('/setup')
        ? { required: false, prompt: '', completedAt: null, sessionId: null, pending: false, revision: 'fixture-setup' }
        : { deleted: 'engine-owner' }))
})
afterEach(async () => {await closeDesktopDatabase(root); await rm(root, {recursive: true, force: true})})

test.each(['tabs', 'delete', 'rename', 'enabled', 'chat'] as const)('an unfinished creation refuses %s before any engine request or local mutation', async operation => {
    await receipt()
    const before = (await db.execute({sql: 'SELECT revision,layout FROM desktop_agent_tabs WHERE agent_id=?', args: [agentId]})).rows[0]
    const action = operation === 'tabs' ? () => writeDesktopTabs(db, agentId, tabs)
        : operation === 'delete' ? () => deleteDesktopCoworker(db, engine, agentId, 'Owner')
            : operation === 'rename' ? () => renameDesktopCoworker(db, engine, 'guard-launch', agentId, 'Changed')
                : operation === 'enabled' ? () => setDesktopCoworkerEnabled(db, engine, agentId, false)
                    : () => startDesktopChat(runtime, {agentId, text: 'Another message', tabUid: requestId})
    await expect(action()).rejects.toMatchObject({status: 409, message: desktopCreationPendingMessage})
    expect((await db.execute({sql: 'SELECT revision,layout FROM desktop_agent_tabs WHERE agent_id=?', args: [agentId]})).rows[0]).toEqual(before)
    expect(await findDesktopAgent(db, agentId)).toMatchObject({name: 'Owner', enabled: true})
    expect(await listDesktopSessions(db, agentId)).toEqual([])
    for (const name of ['desktop_deletions', 'desktop_rename_checks', 'desktop_tab_starts']) expect((await db.execute(`SELECT * FROM ${name}`)).rows).toEqual([])
    for (const call of [mocks.chat, mocks.request, mocks.patch, mocks.get, mocks.model]) expect(call).not.toHaveBeenCalled()
})

test('only the exact internal creation request may send its original kickoff and recover its same tab', async () => {
    await receipt()
    const input = {agentId, text, tabUid: requestId}
    await expect(startDesktopChat(runtime, input, 'different-request')).rejects.toMatchObject({status: 409})
    await expect(startDesktopChat(runtime, {...input, text: 'replacement'}, requestId)).rejects.toMatchObject({status: 409})
    await expect(startDesktopChat(runtime, {...input, tabUid: 'replacement'}, requestId)).rejects.toMatchObject({status: 409})
    await expect(startDesktopChat(runtime, {...input, attachmentPath: 'secret.md'}, requestId)).rejects.toMatchObject({status: 409})
    expect(mocks.chat).not.toHaveBeenCalled()
    const first = await startDesktopChat(runtime, input, requestId)
    await first.response.text()
    const replay = await startDesktopChat(runtime, input, requestId)
    await replay.response.text()
    expect(replay.sessionId).toBe(first.sessionId)
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(mocks.chat.mock.calls[0]![2]).toMatchObject({message: text, desktopFirstTurn: {sessionId: expect.any(String), runId: expect.any(String)}})
    expect(await listDesktopSessions(db, agentId)).toHaveLength(1)
})

test('a browser cannot supply the internal creation exception through the public chat body', async () => {
    await receipt()
    const response = await publicChat(new Request(`${runtime.app.origin}/api/desktop/chat`, {method: 'POST',
        headers: {host: '127.0.0.1:3001', origin: runtime.app.origin, cookie: 'rerun-desktop-session=fixture-session', 'content-type': 'application/json'},
        body: JSON.stringify({agentId, text, tabUid: requestId, internalCreationRequestId: requestId}),
    }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({error: desktopCreationPendingMessage})
    expect(mocks.chat).not.toHaveBeenCalled()
})

test('a reserved owner cannot bypass publication, and the exception never belongs to a different coworker', async () => {
    await receipt('reserved')
    await expect(assertDesktopCreationSettled(db, agentId, requestId)).rejects.toMatchObject({status: 409})
    await expect(assertDesktopCreationSettled(db, peerId, requestId)).rejects.toMatchObject({status: 409})
    await expect(assertDesktopCreationSettled(db, peerId)).resolves.toBeNull()
})

test('settled chat and tabs are available before acknowledgement, but deletion waits for acknowledgement', async () => {
    await receipt('started')
    expect((await writeDesktopTabs(db, agentId, tabs)).conflict).toBe(false)
    const sent = await startDesktopChat(runtime, {agentId, text: 'A later message'})
    await sent.response.text()
    await expect(deleteDesktopCoworker(db, engine, agentId, 'Owner')).rejects.toMatchObject({status: 409})
    expect(mocks.request.mock.calls.filter(([, , options]) => options?.method !== 'GET')).toEqual([])
    await db.execute({sql: 'UPDATE desktop_creations SET acknowledged=1 WHERE request_id=?', args: [requestId]})
    expect(await deleteDesktopCoworker(db, engine, agentId, 'Owner')).toEqual({deletedAgentId: agentId})
    expect(mocks.request.mock.calls.filter(([, , options]) => options?.method === 'DELETE')).toHaveLength(1)
    expect(await findDesktopAgent(db, agentId)).toBeNull()
})

test('a queued tab write rechecks creation state after obtaining the roster lock', async () => {
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    const lock = withRosterWrite(async () => {entered(); await new Promise<void>(resolve => {release = resolve})})
    await started
    const pending = writeDesktopTabs(db, agentId, tabs), rejected = expect(pending).rejects.toMatchObject({status: 409})
    await receipt()
    release(); await lock; await rejected
    expect(JSON.parse(String((await db.execute({sql: 'SELECT layout FROM desktop_agent_tabs WHERE agent_id=?', args: [agentId]})).rows[0]!.layout)).tabs[0].uid).toBe(requestId)
})

test('the unfinished-creation guard survives closing and reopening the database', async () => {
    await receipt()
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    await expect(writeDesktopTabs(db, agentId, tabs)).rejects.toMatchObject({status: 409})
    await expect(startDesktopChat(runtime, {agentId, text: 'different first message'})).rejects.toMatchObject({status: 409})
    expect(mocks.chat).not.toHaveBeenCalled()
})
