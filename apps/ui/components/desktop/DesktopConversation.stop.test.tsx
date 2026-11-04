// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const chat = vi.hoisted(() => ({
    messages: [] as UIMessage[], status: 'ready', error: undefined,
    stop: vi.fn(), setMessages: vi.fn(), sendMessage: vi.fn(),
}))
let acceptResponse: (url: string) => Promise<Response>
vi.mock('@ai-sdk/react', () => ({ useChat: ({ transport }: { transport: { fetch: typeof acceptResponse } }) => {
    acceptResponse = transport.fetch
    return chat
} }))

const agent = { id: 'agent', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
const sessions = [{ id: 'session-1', agentId: 'agent', title: 'One', createdAt: '', updatedAt: '' }]
const saved = Response.json({ messages: [{ id: 'q', role: 'user', parts: [{ type: 'text', text: 'Saved question' }] }] })
let container: HTMLDivElement
let root: Root
let stopResponse: () => Response
let running: boolean
let statusUnavailable: boolean
const requests: string[] = []

beforeEach(() => {
    chat.status = 'ready'; chat.stop.mockReset(); chat.sendMessage.mockReset()
    requests.length = 0
    running = false; statusUnavailable = false
    stopResponse = () => Response.json({ canceled: 1, alreadyFinished: false })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.startsWith('/reply/')) return new Response(null, { headers: { 'x-session-id': url.slice('/reply/'.length) } })
        if (url.endsWith('/messages')) return saved.clone()
        if (url.endsWith('/stop') && init?.method === 'POST') { running = false; return stopResponse() }
        if (url.endsWith('/stop')) return statusUnavailable ? new Response(null, { status: 503 }) : Response.json({ running })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        throw new Error('Unexpected request: ' + url)
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = (sessionId: string | null = 'session-1', enabled = true) => act(async () => { root.render(<DesktopConversation agent={{ ...agent, enabled }} sessionId={sessionId} sessions={sessions} onSelectSession={vi.fn()} onChatSession={vi.fn()} />) })
const button = (name: string) => [...container.querySelectorAll('button')].find(b => b.textContent === name)
async function type(text: string) {
    const composer = container.querySelector('textarea')!
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, text)
        composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

test('Stop while streaming aborts the stream and cancels the engine run, keeping the draft', async () => {
    await render()
    expect(button('Stop')).toBeUndefined()
    await act(async () => { await acceptResponse('/reply/session-1') })
    chat.status = 'streaming'
    await render()
    await type('Unsent follow-up')
    await act(async () => { button('Stop')!.click() })
    expect(chat.stop).toHaveBeenCalledTimes(1)
    expect(requests).toContain('POST /api/desktop/sessions/session-1/stop')
    expect(container.querySelector('textarea')!.value).toBe('Unsent follow-up')
    chat.status = 'ready'
    await render()
    expect(container.textContent).toContain('Saved question')
    expect(button('Send')!.disabled).toBe(false)
})

test('a reopened conversation with a run still in flight offers Stop and cancels it on the engine', async () => {
    running = true
    await render()
    expect(requests).toContain('GET /api/desktop/sessions/session-1/stop')
    expect(button('Stop')).toBeDefined()
    expect(button('Send')!.disabled).toBe(true)
    await act(async () => { button('Stop')!.click() })
    expect(requests).toContain('POST /api/desktop/sessions/session-1/stop')
    expect(button('Stop')).toBeUndefined()
    expect(container.textContent).toContain('Saved question')
})

test('disabling a coworker keeps the running reply and Stop while blocking new sends', async () => {
    await render()
    await type('Keep this draft')
    await act(async () => { await acceptResponse('/reply/session-1') })
    chat.status = 'streaming'
    await render('session-1', false)
    expect(chat.stop).not.toHaveBeenCalled()
    expect(button('Stop')!.disabled).toBe(false)
    expect(button('Send')!.disabled).toBe(true)
    expect(container.querySelector('textarea')!.value).toBe('Keep this draft')
    expect(container.querySelector('textarea')!.disabled).toBe(true)
    await act(async () => { button('Stop')!.click() })
    expect(chat.stop).toHaveBeenCalledTimes(1)
    expect(requests).toContain('POST /api/desktop/sessions/session-1/stop')
    chat.status = 'ready'
    await render('session-1', false)
    expect(container.textContent).toContain('Saved question')
    expect(button('Send')!.disabled).toBe(true)
    await render('session-1', true)
    expect(button('Send')!.disabled).toBe(false)
    expect(container.querySelector('textarea')!.value).toBe('Keep this draft')
})

test('a failed stop is surfaced without losing the draft or the saved conversation', async () => {
    running = true
    stopResponse = () => Response.json({ error: 'Could not stop this reply. Try again.' }, { status: 502 })
    await render()
    await type('Keep me')
    await act(async () => { button('Stop')!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not stop this reply')
    expect(container.querySelector('textarea')!.value).toBe('Keep me')
    expect(container.textContent).toContain('Saved question')
    expect(button('Stop')).toBeDefined()
})

test('an already finished reply clears Stop quietly', async () => {
    running = true
    stopResponse = () => Response.json({ canceled: 0, alreadyFinished: true })
    await render()
    await act(async () => { button('Stop')!.click() })
    expect(button('Stop')).toBeUndefined()
    expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('Stop waits for the current send to get a session ID before enabling, including after New chat', async () => {
    // The previous conversation returned headers; its ID cannot be reused for this new turn.
    await render()
    await act(async () => { await acceptResponse('/reply/session-1') })
    await render(null)
    await type('Question for the new chat')
    await act(async () => { button('Send')!.click() })
    chat.status = 'submitted'
    await render(null)
    await act(async () => { button('Stop')!.click() })
    expect(requests).not.toContain('POST /api/desktop/sessions/session-1/stop')
    expect(chat.stop).not.toHaveBeenCalled()
    expect(button('Stop')!.disabled).toBe(true)
    await act(async () => { await acceptResponse('/reply/session-2') })
    await render('session-2')
    expect(button('Stop')!.disabled).toBe(false)
    await act(async () => { button('Stop')!.click() })
    expect(requests).toContain('POST /api/desktop/sessions/session-2/stop')
})


test('a transient engine status error is retried for a reopened running conversation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
        running = true; statusUnavailable = true
        await render()
        expect(button('Stop')).toBeUndefined()
        statusUnavailable = false
        await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
        expect(button('Stop')).toBeDefined()
        statusUnavailable = true
        await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
        expect(button('Stop')).toBeDefined()
        statusUnavailable = false; running = false
        await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
        expect(button('Stop')).toBeUndefined()
    } finally { vi.useRealTimers() }
})
