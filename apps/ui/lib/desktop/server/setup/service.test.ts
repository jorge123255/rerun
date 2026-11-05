import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EngineRequestError } from '@/lib/engine/client'
import { parseInstallMessage } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent, createDesktopSession } from '../store'
import type { DesktopRuntime } from '../runtime'
import { assertDesktopSetupChatAllowed, mutateDesktopSetup, readDesktopSetupView } from './service'
import { ensureDesktopSetupSchema } from './schema'

const mocks = vi.hoisted(() => ({ request: vi.fn(), chat: vi.fn(), messages: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({
    EngineRequestError: class extends Error { constructor(message: string, readonly status: number) { super(message) } },
    request: (...args: unknown[]) => mocks.request(...args),
    getSessionMessages: (...args: unknown[]) => mocks.messages(...args),
}))
vi.mock('../engine', () => ({ startDesktopChat: (...args: unknown[]) => mocks.chat(...args) }))

type Setup = { required: boolean | null; prompt: string; completedAt: string | null; sessionId: string | null; pending: boolean; revision: string }
let root: string, runtime: DesktopRuntime, owner: string, other: string
let setup: Setup, receipts: Map<string, unknown>, acceptedRuns: Set<string>

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-setup-recovery-'))
    runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'first', buildId: 'qa', dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken: 'session' }, engine: { origin: 'http://127.0.0.1:3200', apiKey: 'key' } }
    const db = await openDesktopDatabase(root)
    owner = (await createDesktopAgent(db, { name: 'Setup owner', engineAgentId: 'setup-owner' })).id
    other = (await createDesktopAgent(db, { name: 'Other', engineAgentId: 'other' })).id
    setup = { required: true, prompt: 'Verify the imported tools.', completedAt: null, sessionId: null, pending: true, revision: 'before' }
    receipts = new Map()
    acceptedRuns = new Set()
    mocks.messages.mockResolvedValue([])
    mocks.request.mockImplementation(async (_engine, path: string, init: RequestInit, parse: (value: unknown) => unknown) => {
        if (init.method === 'GET') return parse({ ...setup })
        const body = JSON.parse(String(init.body))
        if (receipts.has(body.requestId)) return parse(receipts.get(body.requestId))
        if (body.expectedRevision !== setup.revision) throw new EngineRequestError('{"code":"setup_mutation_rejected"}', 409)
        let result: unknown
        if (path.endsWith('/save')) {
            setup = { ...setup, prompt: body.prompt.trim(), required: body.required, completedAt: '2026-11-05T12:00:00Z', sessionId: null, pending: false, revision: 'saved' }
            result = { ...setup }
        } else if (path.endsWith('/claim')) {
            setup = { ...setup, sessionId: 'claimed-engine-session', revision: 'claimed' }
            result = { sessionId: setup.sessionId }
        } else throw new Error(`Unexpected endpoint: ${path}`)
        receipts.set(body.requestId, result)
        return parse(result)
    })
    mocks.chat.mockImplementation(async (_runtime, input) => {
        acceptedRuns.add(input.requestId)
        return { sessionId: input.sessionId, response: new Response('data: [DONE]\n\n', { headers: { 'x-run-id': input.requestId } }) }
    })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
})

test('a lost engine save acknowledgement resumes its exact intent after restart', async () => {
    const before = await readDesktopSetupView(runtime, owner)
    const input = { action: 'save', requestId: crypto.randomUUID(), expectedRevision: before.revision, required: true, prompt: 'Exact instructions.' }
    const actual = mocks.request.getMockImplementation()!
    let dropped = false
    mocks.request.mockImplementation(async (...args) => {
        const result = await actual(...args)
        if (!dropped && String(args[1]).endsWith('/save')) { dropped = true; throw new Error('Lost response after save') }
        return result
    })
    await expect(mutateDesktopSetup(runtime, owner, input)).rejects.toMatchObject({ status: 503 })
    const firstBody = mocks.request.mock.calls.find(call => String(call[1]).endsWith('/save'))![2].body
    await closeDesktopDatabase(root)
    const restarted = { ...runtime, launchNonce: 'second' }
    expect(await readDesktopSetupView(restarted, owner)).toMatchObject({ prompt: 'Exact instructions.', completedAt: setup.completedAt })
    expect(mocks.request.mock.calls.filter(call => String(call[1]).endsWith('/save')).map(call => call[2].body)).toEqual([firstBody, firstBody])
    expect((await mutateDesktopSetup(restarted, owner, input)).view.prompt).toBe('Exact instructions.')
    expect(mocks.chat).not.toHaveBeenCalled()
})

test('a lost kickoff acknowledgement reuses its run ID and setup chat after restart', async () => {
    const before = await readDesktopSetupView(runtime, owner)
    const input = { action: 'start', requestId: crypto.randomUUID(), expectedRevision: before.revision }
    const actual = mocks.chat.getMockImplementation()!
    mocks.chat.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('Lost kickoff response') })
    await expect(mutateDesktopSetup(runtime, owner, input)).rejects.toThrow('Lost kickoff response')
    const firstSend = mocks.chat.mock.calls[0][1]
    expect(parseInstallMessage(firstSend.text)).toMatchObject({ guide: 'Verify the imported tools.', agentName: 'Setup owner' })
    await closeDesktopDatabase(root)
    const restarted = { ...runtime, launchNonce: 'second' }
    const after = await readDesktopSetupView(restarted, owner)
    expect(after.sessionId).toBe(firstSend.sessionId)
    expect(mocks.chat.mock.calls[1][1]).toEqual(firstSend)
    expect(acceptedRuns.size).toBe(1)
    const db = await openDesktopDatabase(root)
    expect((await db.execute({ sql: 'SELECT id FROM desktop_sessions WHERE agent_id=?', args: [owner] })).rows).toHaveLength(1)
    expect((await mutateDesktopSetup(restarted, owner, input)).sessionId).toBe(after.sessionId)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
})

test('skip is durable, distinct from completion and rejects stale or cross-owner intent reuse', async () => {
    const before = await readDesktopSetupView(runtime, owner)
    const input = { action: 'skip', requestId: crypto.randomUUID(), expectedRevision: before.revision }
    expect((await mutateDesktopSetup(runtime, owner, input)).view).toMatchObject({ skipped: true, completedAt: null, pending: false })
    await expect(mutateDesktopSetup(runtime, other, input)).rejects.toMatchObject({ status: 409 })
    await expect(mutateDesktopSetup(runtime, owner, { ...input, action: 'start' })).rejects.toMatchObject({ status: 409 })
    await expect(mutateDesktopSetup(runtime, owner, { ...input, requestId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 })
    await closeDesktopDatabase(root)
    expect(await readDesktopSetupView({ ...runtime, launchNonce: 'second' }, owner)).toMatchObject({ skipped: true, completedAt: null })
    expect(mocks.chat).not.toHaveBeenCalled()
})

test('known pre-effect save rejection releases the owner while unknown failures retain its intent', async () => {
    const before = await readDesktopSetupView(runtime, owner)
    const input = { action: 'save', requestId: crypto.randomUUID(), expectedRevision: before.revision, required: true, prompt: 'Saved next.' }
    const actual = mocks.request.getMockImplementation()!
    let reject = true
    mocks.request.mockImplementation(async (...args) => {
        if (reject && String(args[1]).endsWith('/save')) { reject = false; throw new EngineRequestError('{"code":"setup_mutation_rejected"}', 409) }
        return actual(...args)
    })
    await expect(mutateDesktopSetup(runtime, owner, input)).rejects.toMatchObject({ status: 409 })
    expect((await mutateDesktopSetup(runtime, owner, { ...input, requestId: crypto.randomUUID() })).view.prompt).toBe('Saved next.')
    await expect(mutateDesktopSetup(runtime, owner, input)).rejects.toMatchObject({ status: 409 })
})

test('chat admission accepts the exact setup session, and skip allows normal chats', async () => {
    await expect(assertDesktopSetupChatAllowed(runtime, owner)).rejects.toMatchObject({ status: 409 })
    setup.sessionId = 'setup-owned'
    const db = await openDesktopDatabase(root)
    const own = await createDesktopSession(db, { agentId: owner, engineSessionId: 'setup-owned', title: 'Setup' })
    const wrong = await createDesktopSession(db, { agentId: other, engineSessionId: 'other-session', title: 'Other' })
    await expect(assertDesktopSetupChatAllowed(runtime, owner, wrong.id)).rejects.toMatchObject({ status: 409 })
    await expect(assertDesktopSetupChatAllowed(runtime, owner, own.id)).resolves.toBeUndefined()
    const view = await readDesktopSetupView(runtime, owner)
    await mutateDesktopSetup(runtime, owner, { action: 'skip', requestId: crypto.randomUUID(), expectedRevision: view.revision })
    await expect(assertDesktopSetupChatAllowed(runtime, owner)).resolves.toBeUndefined()
})

test('later panel reads do not rerun schema DDL on the shared connection', async () => {
    const db = await openDesktopDatabase(root)
    await readDesktopSetupView(runtime, owner)
    const ddl = vi.spyOn(db, 'executeMultiple')
    try {
        await readDesktopSetupView(runtime, other)
        const tx = await db.transaction('write')
        try {
            await ensureDesktopSetupSchema(db)
            expect(ddl).not.toHaveBeenCalled()
            await tx.commit()
        } finally { tx.close() }
    } finally { ddl.mockRestore() }
})
