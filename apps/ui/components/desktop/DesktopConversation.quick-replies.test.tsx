// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { DesktopPendingQuestion } from '@/lib/desktop/questions'
import type { DesktopPendingApproval } from '@/lib/desktop/approvals'
import type { DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { DesktopConversation, type ComposerDraft } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = vi.hoisted(() => ({ messages: [] as UIMessage[], status: 'ready', error: undefined as Error | undefined, sendMessage: vi.fn(), regenerate: vi.fn(), stop: vi.fn(), setMessages: vi.fn(), clearError: vi.fn() }))
const harness = vi.hoisted(() => ({ modelReady: true, callbacks: new Map<string, (text: string) => Promise<boolean>>() }))
let transportFetch: typeof fetch
vi.mock('@ai-sdk/react', () => ({ useChat: ({ transport }: { transport: { fetch: typeof fetch } }) => { transportFetch = transport.fetch; return chat } }))
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (ready: boolean) => void }) => { useEffect(() => onReady?.(harness.modelReady), [onReady, harness.modelReady]); return null } }))
vi.mock('./DesktopQuickReplies', async original => {
    const actual = await original<typeof import('./DesktopQuickReplies')>()
    return { DesktopQuickReplies: (props: Parameters<typeof actual.DesktopQuickReplies>[0]) => {
        const id = (props.message as { id?: string }).id
        if (id) harness.callbacks.set(id, props.onSend)
        return <actual.DesktopQuickReplies {...props} />
    } }
})
// Retain real request cards and controls while avoiding native animation cancellation in happy-dom.
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => {
        if (!elements.has(tag)) elements.set(tag, plain(tag))
        return elements.get(tag)!
    }
    return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
        motion: new Proxy(actual.motion, { get(target, key, receiver) {
            if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
            return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
        } }),
    }
})

const agent = { id: 'agent', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
const suggestion = 'Find more'
const reply = (id: string, label = suggestion): UIMessage => ({ id, role: 'assistant', parts: [
    { type: 'text', text: `Reply ${id}` },
    { type: 'dynamic-tool', toolName: 'mcp__rerun__suggest_replies', toolCallId: `${id}-suggestions`, state: 'input-available', input: { replies: [label] } },
] })
const question: DesktopPendingQuestion = { id: 'a'.repeat(64), messageId: 'question-message', toolCallId: 'question-tool', questions: [{ question: 'Which version?', options: ['Latest'] }] }
const approval: DesktopPendingApproval = { id: 'b'.repeat(64), messageId: 'approval-message', toolCallId: 'approval-tool', approvals: [{ action: 'Publish the draft' }] }
type SendBody = { agentId: string; sessionId: string; requestId: string; text: string }
const histories = new Map<string, UIMessage[]>()
const queues = new Map<string, DesktopQueuedMessage>()
const posts: SendBody[] = []
const onChatSession = vi.fn()
let root: Root, container: HTMLDivElement, running: boolean
let send: (body: SendBody) => Promise<Response>
let readQuestion: () => Promise<Response>, readApproval: () => Promise<Response>, readQueue: (key: string) => Promise<Response>

function accepted(body: SendBody) {
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId, 'x-run-id': body.requestId } })
}
function saveAccepted(body: SendBody) {
    histories.set(body.sessionId, [...(histories.get(body.sessionId) ?? []), { id: `user-${body.requestId}`, role: 'user', parts: [{ type: 'text', text: body.text }] }])
    return accepted(body)
}

beforeEach(() => {
    histories.clear(); histories.set('one', [reply('engine-one')]); histories.set('two', [reply('engine-two', 'Open report')])
    queues.clear(); posts.length = 0; harness.callbacks.clear(); harness.modelReady = true; running = false
    chat.messages = []; chat.status = 'ready'; chat.error = undefined
    chat.sendMessage.mockReset(); chat.regenerate.mockReset(); chat.setMessages.mockReset(); chat.stop.mockReset(); onChatSession.mockReset()
    chat.clearError.mockImplementation(() => { chat.error = undefined })
    readQuestion = async () => Response.json({ question: null })
    readApproval = async () => Response.json({ approval: null })
    readQueue = async key => Response.json({ queued: queues.get(key) ?? null })
    send = async body => saveAccepted(body)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local'), sessionId = url.pathname.split('/')[4]
        if (url.pathname.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return readQuestion()
        if (url.pathname.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return readApproval()
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: histories.get(sessionId) ?? [] })
        if (url.pathname.endsWith('/feedback')) return Response.json({ votes: [] })
        if (url.pathname.endsWith('/stop')) return Response.json({ running, runId: running ? 'running-turn' : null, failedRunId: null })
        if (url.pathname.endsWith('/queue')) {
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body)), key = body.scope.sessionId ?? body.scope.tabUid, current = queues.get(key)
                if (body.action === 'enqueue') queues.set(key, body.item)
                else if (current?.id === body.id && body.action === 'remove') queues.delete(key)
                else if (current?.id === body.id) queues.set(key, { ...current, state: body.action === 'attempt' ? 'sending' : 'review' })
                return Response.json({ queued: queues.get(key) ?? null })
            }
            return readQueue(url.searchParams.get('sessionId') ?? url.searchParams.get('tabUid')!)
        }
        if (url.pathname === '/api/desktop/chat' && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as SendBody
            posts.push(body)
            return send(body)
        }
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`)
    }))
    chat.sendMessage.mockImplementation(async (message: { text: string }, options: { body: object }) => {
        try {
            const response = await transportFetch('/api/desktop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...options.body, text: message.text }) })
            await response.text()
        } catch (cause) {
            // The SDK can fulfill sendMessage after recording a failed transport in error state.
            chat.error = cause instanceof Error ? cause : new Error('Send failed')
            chat.status = 'error'
        }
    })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})

afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); vi.unstubAllGlobals() })
const render = ({ sessionId = 'one', draft, active = true, enabled = true }: { sessionId?: string | null; draft?: ComposerDraft; active?: boolean; enabled?: boolean } = {}) => act(async () => {
    root.render(<DesktopConversation agent={{ ...agent, enabled }} sessionId={sessionId} sessions={[]} initialDraft={draft} active={active} onChatSession={onChatSession} onSelectSession={() => {}} />)
})
const button = (label: string) => [...container.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)
const click = async (label: string) => {
    expect(button(label), label).toBeDefined()
    await act(async () => { button(label)!.click() })
}
const composer = () => container.querySelector<HTMLTextAreaElement>('#desktop-message')!
async function invoke(callback: (text: string) => Promise<boolean>, text: string) {
    let accepted = true
    await act(async () => { accepted = await callback(text) })
    return accepted
}

test('a saved suggested reply sends only its label with an identified receipt and preserves the text and file draft', async () => {
    await render({ draft: { text: 'My independent draft', attachment: 'notes.md' } })
    expect(button(suggestion)?.disabled).toBe(false)
    expect(container.textContent).not.toContain('mcp__rerun__suggest_replies')
    await click(suggestion)
    expect(posts).toEqual([{ agentId: agent.id, sessionId: 'one', requestId: expect.any(String), text: suggestion }])
    expect(chat.sendMessage).toHaveBeenCalledExactlyOnceWith({ text: suggestion }, { body: { agentId: agent.id, sessionId: 'one', requestId: posts[0].requestId } })
    expect(composer().value).toBe('My independent draft')
    expect(button('Remove attachment notes.md')).toBeDefined()
    expect(button(suggestion)).toBeUndefined()
    expect(onChatSession).toHaveBeenCalledExactlyOnceWith('one', undefined)
})

test.each(['http', 'network', 'wrong-session', 'wrong-run', 'missing-run'] as const)('a %s failure swallowed by the SDK re-enables a retry with the same request UUID', async mode => {
    send = async body => {
        if (posts.length > 1) return saveAccepted(body)
        if (mode === 'network') throw new Error('Connection interrupted')
        if (mode === 'http') return Response.json({ error: 'Try this reply again' }, { status: 502 })
        const headers = new Headers({ 'content-type': 'text/event-stream', 'x-session-id': mode === 'wrong-session' ? 'foreign' : body.sessionId })
        if (mode !== 'missing-run') headers.set('x-run-id', mode === 'wrong-run' ? 'foreign-run' : body.requestId)
        return new Response('data: [DONE]\n\n', { headers })
    }
    await render({ draft: { text: 'Preserved draft', attachment: 'notes.md' } })
    await click(suggestion)
    expect(posts).toHaveLength(1)
    expect(onChatSession).not.toHaveBeenCalled()
    expect(button(suggestion)?.disabled).toBe(false)
    expect(composer().value).toBe('Preserved draft')
    await click(suggestion)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(onChatSession).toHaveBeenCalledTimes(1)
    expect(composer().value).toBe('Preserved draft')
    expect(button('Remove attachment notes.md')).toBeDefined()
})

test('a fast retry removes the failed optimistic SDK row before a deferred history reload finishes', async () => {
    let holdHistory = false, finish!: () => void
    const pendingReads: ((response: Response) => void)[] = []
    const snapshots: UIMessage[][] = []
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/messages') && holdHistory) return new Promise<Response>(resolve => { pendingReads.push(resolve) })
        return originalFetch(input, init)
    }))
    // Unlike the ordinary transport fixture, mirror the SDK's optimistic append and retention
    // after a swallowed send error. Hydration and the explicit pre-send reset must update it.
    chat.setMessages.mockImplementation((messages: UIMessage[]) => { chat.messages = messages })
    chat.sendMessage.mockImplementation(async (message: { text: string }, options: { body: object }) => {
        chat.messages = [...chat.messages, { id: `optimistic-${snapshots.length}`, role: 'user', parts: [{ type: 'text', text: message.text }] }]
        snapshots.push([...chat.messages])
        chat.status = 'submitted'
        try {
            const response = await transportFetch('/api/desktop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...options.body, text: message.text }) })
            chat.status = 'streaming'
            await response.text()
        } catch (cause) {
            chat.error = cause instanceof Error ? cause : new Error('Send failed')
            chat.status = 'error'
        }
    })
    send = async body => {
        if (posts.length === 1) {
            holdHistory = true
            throw new Error('Acknowledgement unavailable')
        }
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            finish = () => controller.close()
        } }), { headers: { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId, 'x-run-id': body.requestId } })
    }
    await render({ draft: { text: 'Keep my ordinary draft' } })
    await click(suggestion)
    expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(pendingReads.length).toBeGreaterThan(0)
    expect(button(suggestion)?.disabled).toBe(false)
    // Retry before any authoritative refresh can remove the failed optimistic message.
    await click(suggestion)
    expect(posts).toHaveLength(2)
    expect(posts[1].requestId).toBe(posts[0].requestId)
    expect(snapshots[1].filter(message => message.role === 'user')).toHaveLength(1)
    expect(container.querySelector('[aria-label="Chat messages"]')?.textContent?.match(/Find more/g)).toHaveLength(1)
    expect(composer().value).toBe('Keep my ordinary draft')
    holdHistory = false
    histories.set('one', [reply('engine-one'), { id: 'saved-user', role: 'user', parts: [{ type: 'text', text: suggestion }] }])
    await act(async () => { chat.status = 'ready'; finish() })
    await act(async () => { for (const release of pendingReads) release(Response.json({ messages: [reply('engine-one')] })) })
    expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(posts).toHaveLength(2)
})

test('the synchronous request claim blocks duplicate suggestions, ordinary Send and regeneration before SDK busy state changes', async () => {
    let release!: (response: Response) => void
    send = () => new Promise<Response>(resolve => { release = resolve })
    await render({ draft: { text: 'Do not send this draft' } })
    const chip = button(suggestion)!, regenerate = button('Regenerate reply')!
    await act(async () => {
        chip.click(); chip.click()
        composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        regenerate.click()
    })
    expect(posts).toHaveLength(1)
    expect(chat.sendMessage).toHaveBeenCalledTimes(1)
    expect(chat.regenerate).not.toHaveBeenCalled()
    expect(composer().value).toBe('Do not send this draft')
    await act(async () => { release(saveAccepted(posts[0])) })
    expect(posts).toHaveLength(1)
    expect(composer().value).toBe('Do not send this draft')
})

test('only the latest assistant message can send, and a retained callback cannot use a superseded suggestion', async () => {
    await render()
    const stale = harness.callbacks.get('engine-one')!
    histories.set('one', [reply('engine-one'), reply('engine-latest', 'Open report')])
    chat.status = 'streaming'; await render(); chat.status = 'ready'; await render()
    expect(button(suggestion)).toBeUndefined()
    expect(button('Open report')?.disabled).toBe(false)
    expect(await invoke(stale, suggestion)).toBe(false)
    expect(await invoke(harness.callbacks.get('engine-latest')!, 'Not an offered reply')).toBe(false)
    expect(posts).toHaveLength(0)
    await click('Open report')
    expect(posts[0]).toMatchObject({ sessionId: 'one', text: 'Open report' })
})

test('a retained callback cannot answer another tab, an inactive tab or a blank conversation', async () => {
    await render()
    const stale = harness.callbacks.get('engine-one')!
    await render({ active: false })
    expect(await invoke(stale, suggestion)).toBe(false)
    await render({ sessionId: 'two' })
    expect(await invoke(stale, suggestion)).toBe(false)
    expect(posts).toHaveLength(0)
    await click('Open report')
    expect(posts[0]).toMatchObject({ sessionId: 'two', text: 'Open report' })
    await render({ sessionId: null })
    expect(await invoke(stale, suggestion)).toBe(false)
    expect(posts).toHaveLength(1)
})

test.each(['question', 'approval'] as const)('pending and still-unknown %s reads never expose suggested-send buttons', async kind => {
    let release!: (response: Response) => void
    const deferred = () => new Promise<Response>(resolve => { release = resolve })
    if (kind === 'question') readQuestion = deferred
    else readApproval = deferred
    await render({ draft: { text: 'Separate draft' } })
    expect(button(suggestion)).toBeUndefined()
    const response = kind === 'question' ? { question } : { approval }
    await act(async () => { release(Response.json(response)) })
    expect(button(suggestion)).toBeUndefined()
    expect(await invoke(harness.callbacks.get('engine-one')!, suggestion)).toBe(false)
    expect(posts).toHaveLength(0)
    expect(composer().value).toBe('Separate draft')
})

test.each(['disabled-coworker', 'model-not-ready', 'saved-queue', 'queue-error', 'queue-unknown', 'reopened-run'] as const)('the %s guard rejects direct callback invocation as well as clicks', async mode => {
    let release: ((response: Response) => void) | undefined
    if (mode === 'model-not-ready') harness.modelReady = false
    if (mode === 'saved-queue') queues.set('one', { id: crypto.randomUUID(), text: 'Saved queued draft', createdAt: Date.now(), state: 'waiting', behindRunId: null })
    if (mode === 'queue-error') readQueue = async () => Response.json({ error: 'Queue unavailable' }, { status: 502 })
    if (mode === 'queue-unknown') readQueue = () => new Promise<Response>(resolve => { release = resolve })
    if (mode === 'reopened-run') running = true
    await render({ enabled: mode !== 'disabled-coworker', draft: { text: 'Keep newer draft' } })
    expect(button(suggestion) === undefined || button(suggestion)!.disabled).toBe(true)
    expect(await invoke(harness.callbacks.get('engine-one')!, suggestion)).toBe(false)
    expect(posts).toHaveLength(0)
    expect(composer().value).toBe('Keep newer draft')
    if (release) await act(async () => { release!(Response.json({ queued: null })) })
})
