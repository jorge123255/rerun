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
vi.mock('@ai-sdk/react', () => ({ useChat: () => chat }))

const agent = { id: 'agent', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
const sessions = [{ id: 'session-1', agentId: 'agent', title: 'One', createdAt: '', updatedAt: '' }]
const saved = Response.json({ messages: [{ id: 'q', role: 'user', parts: [{ type: 'text', text: 'Saved question' }] }] })
let container: HTMLDivElement
let root: Root
let stopResponse: () => Response
let running: boolean
const requests: string[] = []

beforeEach(() => {
    chat.status = 'ready'; chat.stop.mockReset(); chat.sendMessage.mockReset()
    requests.length = 0
    running = false
    stopResponse = () => Response.json({ canceled: 1, alreadyFinished: false })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.endsWith('/messages')) return saved.clone()
        if (url.endsWith('/stop') && init?.method === 'POST') { running = false; return stopResponse() }
        if (url.endsWith('/stop')) return Response.json({ running })
        throw new Error('Unexpected request: ' + url)
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const render = () => act(async () => { root.render(<DesktopConversation agent={agent} sessionId="session-1" sessions={sessions} onSelectSession={vi.fn()} onChatSession={vi.fn()} />) })
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
