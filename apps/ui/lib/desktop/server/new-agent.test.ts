import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { readDesktopBoardState, writeDesktopBoardState } from './spaces'
import type { DesktopRuntime } from './runtime'
import { acknowledgeDesktopCreation, createDescribedDesktopCoworker, readPendingDesktopCreation } from './new-agent'

const mocks = vi.hoisted(() => ({ create: vi.fn(), chat: vi.fn(), model: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ request: (...args: unknown[]) => mocks.create(...args) }))
vi.mock('./engine', () => ({ startDesktopChat: (...args: unknown[]) => mocks.chat(...args) }))
vi.mock('./settings', () => ({ desktopModel: (...args: unknown[]) => mocks.model(...args), engineOf: (runtime: DesktopRuntime) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }) }))
let root: string, runtime: DesktopRuntime
let input: Parameters<typeof createDescribedDesktopCoworker>[1]
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-new-coworker-'))
    runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'first', buildId: 'qa', dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken: 'session' }, engine: { origin: 'http://127.0.0.1:3200', apiKey: 'key' } }
    const db = await openDesktopDatabase(root)
    const board = await readDesktopBoardState(db)
    const withBox = board.spaces.length ? board : await writeDesktopBoardState(db, { baseRevision: board.revision, requestId: crypto.randomUUID(), command: { kind: 'create', name: 'QA' } })
    const box = withBox.spaces[0]
    input = { intent: { requestId: crypto.randomUUID(), name: 'QA Writer', kickoff: 'Keep this opening message exactly.', suggestionId: null, scheduled: false },
        spaceId: box.id, position: { col: box.col_start, row: box.row_start } }
    mocks.model.mockResolvedValue({ connection: { id: 'mac-chatgpt', provider: 'codex' } })
    mocks.create.mockImplementation(async (_engine, path, init, parse) => {
        expect(path).toBe('/desktop/agents/create')
        const body = JSON.parse(init.body)
        return parse({ id: `new-${body.requestId}`, config: body.config })
    })
    mocks.chat.mockImplementation(async () => ({ sessionId: 'first-session', response: new Response('data: [DONE]\n\n') }))
})
afterEach(async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }); vi.clearAllMocks() })

test('places one coworker and first chat, retaining the completed receipt until acknowledgement', async () => {
    const result = await createDescribedDesktopCoworker(runtime, input)
    expect(result.agent.position).toEqual(input.position)
    expect(result.agent.spaceId).toBe(input.spaceId)
    expect(mocks.chat).toHaveBeenCalledExactlyOnceWith(runtime, { agentId: result.agent.id, text: input.intent.kickoff, tabUid: input.intent.requestId })
    const sent = JSON.parse(mocks.create.mock.calls[0][2].body)
    expect(sent.config.description).toBe('')
    expect(sent.config).not.toHaveProperty('tools')
    expect(await readPendingDesktopCreation(runtime)).toMatchObject({ intent: input.intent, phase: 'started' })
    await closeDesktopDatabase(root)
    const restarted = { ...runtime, launchNonce: 'second' }
    expect(await createDescribedDesktopCoworker(restarted, input)).toEqual(result)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    await acknowledgeDesktopCreation(restarted, input.intent.requestId)
    expect(await readPendingDesktopCreation(restarted)).toBeNull()
})

test('lost engine response preserves placement and exact config across restart, without creating a second local owner', async () => {
    const realCreate = mocks.create.getMockImplementation()!
    mocks.create.mockImplementationOnce(async (...args) => { await realCreate(...args); throw new Error('Lost response') })
    await expect(createDescribedDesktopCoworker(runtime, input)).rejects.toThrow('Lost response')
    expect(await readPendingDesktopCreation(runtime)).toMatchObject({ phase: 'reserved', position: input.position })
    const db = await openDesktopDatabase(root)
    const board = await readDesktopBoardState(db)
    await expect(writeDesktopBoardState(db, { requestId: crypto.randomUUID(), baseRevision: board.revision, command: { kind: 'delete', spaceId: input.spaceId } })).rejects.toThrow()
    expect((await db.execute('SELECT id FROM desktop_agents')).rows).toHaveLength(0)
    await closeDesktopDatabase(root)
    mocks.model.mockResolvedValue({ connection: { id: 'different', provider: 'openai' } })
    const result = await createDescribedDesktopCoworker({ ...runtime, launchNonce: 'second' }, input)
    expect(mocks.create.mock.calls[0][2].body).toBe(mocks.create.mock.calls[1][2].body)
    expect((await (await openDesktopDatabase(root)).execute('SELECT id FROM desktop_agents')).rows.map(row => row.id)).toEqual([result.agent.id])
    expect(mocks.chat).toHaveBeenCalledTimes(1)
})

test('an existing coworker does not skip an unconfirmed kickoff after restart', async () => {
    mocks.chat.mockRejectedValueOnce(new Error('Kickoff not confirmed'))
    await expect(createDescribedDesktopCoworker(runtime, input)).rejects.toThrow('Kickoff not confirmed')
    expect(await readPendingDesktopCreation(runtime)).toMatchObject({ phase: 'created' })
    await expect(acknowledgeDesktopCreation(runtime, input.intent.requestId)).rejects.toMatchObject({ status: 409 })
    await closeDesktopDatabase(root)
    const result = await createDescribedDesktopCoworker({ ...runtime, launchNonce: 'second' }, input)
    expect(result.sessionId).toBe('first-session')
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(mocks.chat.mock.calls[0][1]).toEqual(mocks.chat.mock.calls[1][1])
})

test('concurrent exact retries coalesce, while changed payloads and new IDs cannot abandon an unfinished creation', async () => {
    let finish!: () => void
    const actual = mocks.create.getMockImplementation()!
    mocks.create.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve }); return actual(...args) })
    const first = createDescribedDesktopCoworker(runtime, input)
    const second = createDescribedDesktopCoworker(runtime, input)
    expect(first).toBe(second)
    await expect(createDescribedDesktopCoworker(runtime, { ...input, intent: { ...input.intent, kickoff: 'Changed' } })).rejects.toMatchObject({ status: 409 })
    while (!finish) await new Promise(resolve => setTimeout(resolve, 5))
    finish()
    await first
    await expect(createDescribedDesktopCoworker(runtime, { ...input, intent: { ...input.intent, requestId: crypto.randomUUID() } })).rejects.toMatchObject({ status: 409 })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(1)
})
