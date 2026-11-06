// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
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
it('refuses foreign state and hides context parts from restored transcript', async () => {
    server.messages = [{ id: 'one', role: 'user', parts: [{ type: 'text', text: 'Visible message' }, { type: 'text', text: 'private context', providerOptions: { rerun: { context: true } } }] }]
    expect(desktopForemanMessages(await readDesktopForemanState())).toEqual([{ id: 'one', role: 'user', text: 'Visible message' }])
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
