// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { foremanDocumentScope } from '@rerun/contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { DEFAULT_DESKTOP_FOREMAN_PLACEMENT } from './persistence'
import { flushDesktopForemanUiSaves } from './actions'
import { createDesktopForemanClient, desktopForemanMessages, readDesktopForemanState, type DesktopForemanClientState } from './runtime-client'
const chat = { workspaceId: '1', chatId: 'fmc_abcdefgh' }
const model = { connectionId: 'chatgpt', model: 'terra' }
function initial(): DesktopForemanClientState {
    return { chat, sessionId: 'session', model: null, messages: [], view: { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null }, ui: { revision: 0, snapshot: { ...chat, open: true, tab: 'assistant', draft: 'hello', pendingPlanRevisionId: null, decision: { status: 'idle' }, build: null, discoveries: null, placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT } } }
}
let server: DesktopForemanClientState
let bodies: Array<Record<string, unknown>>
let clients: Array<ReturnType<typeof createDesktopForemanClient>>
let onOpenCoworker = vi.fn<(target: { agentId: string; sessionId?: string }) => void>(), onOpenBox = vi.fn<(spaceId: string) => void>()
const connect = (state = server, choice?: typeof model) => { const client = createDesktopForemanClient(structuredClone(state), { onState: vi.fn(), onError: vi.fn(), onOpenCoworker, onOpenBox, modelChoice: () => choice }); clients.push(client); return client }
beforeEach(() => {
    cancelDraftShutdown(); vi.stubGlobal('crypto', { randomUUID }); server = initial(); bodies = []; clients = []
    onOpenCoworker = vi.fn<(target: { agentId: string; sessionId?: string }) => void>(); onOpenBox = vi.fn<(spaceId: string) => void>()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (!init?.body) return Response.json(server)
        const body = JSON.parse(String(init.body)); bodies.push(body)
        if (body.action === 'ui') {
            if (body.expectedRevision !== server.ui.revision) return Response.json({ error: 'changed' }, { status: 409 })
            server.ui = { revision: server.ui.revision + 1, snapshot: body.snapshot }
            return Response.json({ revision: server.ui.revision })
        }
        if (body.action === 'send') return Response.json({ runId: body.requestId })
        return Response.json({ ok: true })
    }))
})
afterEach(async () => { clients.forEach(client => client.close()); await flushDesktopForemanUiSaves(); vi.unstubAllGlobals(); cancelDraftShutdown() })
it('persists immutable send identity before execution and recovers the same request/model after a lost ACK and remount', async () => {
    const transport = vi.mocked(fetch).getMockImplementation()!
    let lost = false
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (body?.action === 'send' && !lost) {
            lost = true; bodies.push(body)
            expect(server.ui.snapshot?.pendingSend).toMatchObject({ requestId: body.requestId, text: 'hello', modelChoice: model })
            throw new Error('lost acknowledgement')
        }
        return transport(url, init)
    })
    const first = connect(server, model)
    await expect(first.ports.conversation.sendMessage('hello')).rejects.toThrow('lost acknowledgement')
    const request = server.ui.snapshot?.pendingSend
    expect(request).toBeTruthy(); first.close()
    const restarted = connect(await readDesktopForemanState())
    await expect(restarted.ports.conversation.sendMessage('different')).rejects.toThrow('previous message')
    expect(await restarted.ports.conversation.sendMessage('hello')).toBe(true)
    const sends = bodies.filter(body => body.action === 'send')
    expect(sends).toHaveLength(2); expect(sends.map(body => body.requestId)).toEqual([request!.requestId, request!.requestId])
    expect(sends.every(body => JSON.stringify(body.modelChoice) === JSON.stringify(model))).toBe(true)
    expect(server.ui.snapshot?.pendingSend).toBeUndefined()
})
it('recovers a file-only send from the composer without preparing or uploading the attachment again', async () => {
    const transport = vi.mocked(fetch).getMockImplementation()!
    const documents = { scope: foremanDocumentScope(chat, server.sessionId), admissionId: randomUUID(), attachmentIds: [randomUUID()], modelChoice: model }
    const prepare = vi.fn(async () => documents)
    let lost = false
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (body?.action === 'send' && !lost) {
            lost = true
            expect(server.ui.snapshot?.pendingSend).toEqual({ requestId: body.requestId, text: '', modelChoice: model, documents })
            throw new Error('lost file acknowledgement')
        }
        return transport(url, init)
    })
    const client = connect(server, model)
    await expect(client.ports.conversation.sendMessage('', undefined, prepare)).rejects.toThrow('lost file acknowledgement')
    const requestId = server.ui.snapshot?.pendingSend?.requestId
    client.close()
    const restored = connect(await readDesktopForemanState())
    await expect(restored.ports.conversation.sendMessage('')).rejects.toThrow('Retry the attached message')
    expect(await restored.ports.conversation.sendMessage('', undefined, prepare)).toBe(true)
    expect(prepare).toHaveBeenCalledExactlyOnceWith(model)
    expect(bodies.find(body => body.action === 'send')).toMatchObject({ requestId, text: '', modelChoice: model, documents })
    expect(server.ui.snapshot?.pendingSend).toBeUndefined()
})
it('uses an acknowledged model immediately and ignores a state read that predates the change', async () => {
    const transport = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let read = false
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (!init?.body && !read) {
            read = true
            const prior = structuredClone(server)
            await gate
            return Response.json(prior)
        }
        const body = init?.body && JSON.parse(String(init.body))
        if (body?.action === 'model') {
            bodies.push(body)
            server.model = body.model
            return Response.json({ model: server.model })
        }
        return transport(url, init)
    })
    const client = connect()
    const earlierRead = client.refresh()
    await client.setModel(null, model)
    release()
    expect((await earlierRead).model).toEqual(model)
    expect(await client.ports.conversation.sendMessage('Use the selected model')).toBe(true)
    expect(bodies.find(body => body.action === 'model')).toEqual({ action: 'model', chat, expected: null, model })
    expect(bodies.find(body => body.action === 'send')?.modelChoice).toEqual(model)
})
it('recovers only an exact saved snapshot after a lost UI ACK and then advances the CAS revision', async () => {
    const transport = vi.mocked(fetch).getMockImplementation()!
    let lost = false
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        const result = await transport(url, init)
        if (init?.body && JSON.parse(String(init.body)).action === 'ui' && !lost) { lost = true; throw new Error('lost UI ACK') }
        return result
    })
    const client = connect()
    await client.ports.persistence.save({ ...server.ui.snapshot!, draft: 'first' })
    await client.ports.persistence.save({ ...server.ui.snapshot!, draft: 'second' })
    expect(server.ui.snapshot?.draft).toBe('second')
    expect(bodies.filter(body => body.action === 'ui').map(body => body.expectedRevision)).toEqual([0, 1])
})
it('recovers an exact starter answer after a lost response without sending ordinary chat', async () => {
    const offerId = randomUUID(), intakeRequestId = randomUUID(), digest = 'a'.repeat(64)
    const choice = { kind: 'text' as const, text: 'Design a support coworker' }
    server.starter = { offerId, intakeRequestId, digest, decision: null, cards: [{ templateId: 'b'.repeat(32), revision: 'c'.repeat(64), title: 'Support' }] }
    const transport = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (body?.action === 'starter') {
            bodies.push(body)
            server.starter!.decision = { choice, settled: true }
            throw new Error('Lost starter response')
        }
        return transport(url, init)
    })
    const client = connect()
    expect(await client.ports.conversation.sendMessage(choice.text)).toBe(false)
    await expect(client.answerStarter({ offerId, intakeRequestId, digest: 'd'.repeat(64), choice })).rejects.toThrow('cannot be answered')
    expect(bodies).toEqual([])
    await expect(client.answerStarter({ offerId, intakeRequestId, digest, choice })).resolves.toBeUndefined()
    expect(bodies).toEqual([{ action: 'starter', chat, input: { offerId, intakeRequestId, digest, choice } }])
    expect((await client.refresh()).starter?.decision).toEqual({ choice, settled: true })
})
it('refuses foreign state and hides context parts from restored transcript', async () => {
    server.messages = [{ id: 'one', role: 'user', parts: [{ type: 'text', text: 'Visible message' }, { type: 'text', text: 'private context', providerOptions: { rerun: { context: true } } }] }]
    expect(desktopForemanMessages(await readDesktopForemanState())).toEqual([{ id: 'one', role: 'user', text: 'Visible message', docs: [], history: [{ key: '["one",0,null]', kind: 'text', text: 'Visible message' }] }])
    server.view.chat = { ...chat, chatId: 'fmc_otherchat' }
    await expect(readDesktopForemanState()).rejects.toThrow()
})
it('does not navigate from history reads and accepts only one exact live SSE navigation', async () => {
    server.view.live = { runId: 'run-one', model }
    const client = connect()
    await client.refresh()
    expect(onOpenCoworker).not.toHaveBeenCalled()
    const event = { type: 'navigation', binding: { ...chat, runId: 'run-one', model }, intent: { kind: 'open_coworker', agentId: 'alex', sessionId: 'session-alex' }, eventId: 'event-one' }
    client.acceptEvent({ ...event, binding: { ...event.binding, runId: 'old-run' } })
    client.acceptEvent({ ...event, binding: { ...event.binding, model: { ...model, model: 'other' } } })
    client.acceptEvent({ ...event, binding: { ...event.binding, chatId: 'fmc_otherchat' } })
    expect(onOpenCoworker).not.toHaveBeenCalled()
    client.acceptEvent(event); client.acceptEvent(event)
    expect(onOpenCoworker).toHaveBeenCalledTimes(1); expect(onOpenCoworker).toHaveBeenCalledWith({ agentId: 'alex', sessionId: 'session-alex' })
    client.close(); client.acceptEvent({ ...event, eventId: 'event-two' })
    expect(onOpenCoworker).toHaveBeenCalledTimes(1)
})
it('keeps deliberate saved-card navigation available while historical', async () => {
    const client = connect()
    await client.ports.navigation.dispatch({ ...chat, runId: null, liveObserved: false, intent: { kind: 'open_box', spaceId: 'space' } })
    expect(onOpenBox).toHaveBeenCalledTimes(1); expect(onOpenBox).toHaveBeenCalledWith('space')
})
it('bounds streamed state before accumulating a full oversized response', async () => {
    let index = 0
    const cancel = vi.fn()
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (index++ < 100) controller.enqueue(new Uint8Array(3 * 1024 * 1024)); else controller.close() }, cancel })))
    await expect(readDesktopForemanState()).rejects.toThrow('too large')
    expect(cancel).toHaveBeenCalled()
})
it('cancel before provider admission clears only its new pending send and never dispatches it', async () => {
    const transport = vi.mocked(fetch).getMockImplementation()!
    const abort = new AbortController()
    let stopped = false
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        const response = await transport(url, init)
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (!stopped && body?.action === 'ui' && body.snapshot.pendingSend) { stopped = true; abort.abort() }
        return response
    })
    const client = connect()
    await expect(client.ports.conversation.sendMessage('from palette', abort.signal)).rejects.toThrow()
    expect(bodies.filter(body => body.action === 'send')).toHaveLength(0)
    expect(server.ui.snapshot?.pendingSend).toBeUndefined()
    expect(await client.ports.conversation.sendMessage('next message')).toBe(true)
})
it('serializes explicit Ask against normal composer send and forwards cancellation to admitted transport', async () => {
    const transport = vi.mocked(fetch).getMockImplementation()!
    const abort = new AbortController()
    let sent!: () => void
    const admitted = new Promise<void>(resolve => { sent = resolve })
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (init?.body && JSON.parse(String(init.body)).action === 'send') {
            sent()
            return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('cancelled transport')), { once: true }))
        }
        return transport(url, init)
    })
    const client = connect()
    const first = client.ports.conversation.sendMessage('first', abort.signal)
    const failure = expect(first).rejects.toThrow('cancelled transport')
    await admitted
    expect(await client.ports.conversation.sendMessage('second')).toBe(false)
    abort.abort(); await failure
    expect(server.ui.snapshot?.pendingSend?.text).toBe('first')
})


it('retains static and dynamic documentation parts while omitting unrelated restored tool details', () => {
    const state = initial()
    state.messages = [{ id: 'docs', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'search_docs', toolCallId: 'docs-1', state: 'output-available', output: {} }, { type: 'tool-search_docs', toolCallId: 'docs-2', state: 'output-available', output: {} }, { type: 'tool-unrelated', output: 'private detail' }] }]
    expect(desktopForemanMessages(state)[0].docs).toHaveLength(2)
    expect(JSON.stringify(desktopForemanMessages(state))).not.toContain('private detail')
})


it('submits the authoritative Foreman card through the answer action and blocks an ordinary send', async () => {
    const questionId = 'a'.repeat(64)
    server.question = { id: questionId, messageId: 'm', toolCallId: 'c', questions: [{ question: 'Which?', options: ['One', 'Two'] }] }
    const client = connect()
    const answer = { questionId, requestId: randomUUID(), action: 'answer' as const, answers: [['One']] }
    const transport = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (body?.action !== 'answer') return transport(url, init)
        bodies.push(body)
        server.question = null
        return Response.json({ runId: answer.requestId })
    })
    expect(await client.ports.conversation.sendMessage('Ordinary text')).toBe(false)
    await expect(client.answerQuestion({ ...answer, questionId: 'b'.repeat(64) })).rejects.toThrow('cannot be answered')
    await client.answerQuestion(answer)
    expect(bodies).toEqual([{ action: 'answer', chat, input: answer }])
})
