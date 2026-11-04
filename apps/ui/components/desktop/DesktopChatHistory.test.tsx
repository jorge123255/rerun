// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopApp, type DesktopBootstrap, type DesktopSessionView } from './DesktopApp'
import { DesktopChatHistory, groupDesktopChats } from './DesktopChatHistory'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createdAt = '2026-01-01T12:00:00.000Z'
const openTile = (name: string) => act(async () => {
    document.querySelector<HTMLElement>(`[aria-label="Open chat with ${name}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
const session = (id: string, agentId: string, title: string): DesktopSessionView => ({ id, agentId, title, createdAt, updatedAt: '2026-11-01T12:00:00.000Z' })
const click = (label: string) => act(async () => {
    const button = [...document.querySelectorAll('button')].find(b => !b.closest('[hidden]') && (b.textContent?.trim() === label || b.getAttribute('aria-label') === label))
    expect(button, `button ${label}`).toBeTruthy()
    button!.click()
    await new Promise(resolve => setTimeout(resolve, 100))
})
const enter = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    const prototype = input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
})

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

test('groups by creation date without presenting the unused update timestamp as activity', () => {
    const older = session('old', 'a', 'Older')
    const newer = { ...session('new', 'a', 'Newer'), createdAt: '2026-01-02T12:00:00.000Z' }
    const invalid = { ...session('unknown', 'a', 'Unknown'), createdAt: '' }
    const input = [older, invalid, newer]
    const groups = groupDesktopChats(input, new Date('2026-01-02T23:00:00.000Z'))
    expect(groups.map(group => group.day)).toEqual(['Today', 'Yesterday', 'Date unavailable'])
    expect(groups.flatMap(group => group.sessions.map(entry => entry.id))).toEqual(['new', 'old', 'unknown'])
    expect(input).toEqual([older, invalid, newer])
})

test('browses, searches, marks the active conversation, and disables switching while busy', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const select = vi.fn()
    const sessions = [session('a', 'agent', 'Apple research'), session('b', 'agent', 'Banana research')]
    const render = (busy: boolean, entries = sessions) => act(async () => {
        root.render(<DesktopChatHistory sessions={entries} selectedId="a" busy={busy} onSelect={select} />)
    })
    try {
        await render(false)
        await click('Conversation history (2)')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Dates show when chats were created.')
        expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('Apple research')
        expect(document.querySelector('time')?.getAttribute('datetime')).toBe(createdAt)
        await enter(document.querySelector<HTMLInputElement>('input[type="search"]')!, 'Banana')
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Apple research')
        await enter(document.querySelector<HTMLInputElement>('input[type="search"]')!, 'Missing title')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No matching conversations.')
        await enter(document.querySelector<HTMLInputElement>('input[type="search"]')!, 'Banana')
        await click([...document.querySelectorAll('button')].find(b => b.textContent?.includes('Banana research'))!.textContent!)
        expect(select).toHaveBeenCalledExactlyOnceWith('b')
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        await click('Conversation history (2)')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Apple research')
        await render(true)
        expect(container.querySelector('button')?.disabled).toBe(true)
        expect([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].every(button => button.disabled)).toBe(true)
        await render(false, [])
        await click('Conversation history (0)')
        await click('Conversation history (0)')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No saved conversations yet.')
    } finally { await act(async () => { root.unmount() }) }
})

test('switches distinct transcripts, keeps New chat separate, reopens, and isolates coworkers', async () => {
    const agents = ['Alice', 'Bob'].map(name => ({ id: name.toLowerCase(), name, description: '', createdAt, updatedAt: createdAt }))
    const saved = [session('alpha', 'alice', 'Apples'), session('beta', 'alice', 'Bananas'), session('gamma', 'bob', 'Carrots')]
    const transcripts = new Map(saved.map(s => [s.id, [{ id: s.id, role: 'assistant', parts: [{ type: 'text', text: `${s.title} answer` }] }]]))
    const initialData: DesktopBootstrap = { theme: 'system', profile: { id: 1, displayName: 'Test' }, workspace: { id: 1, name: 'Disposable' }, agents, connections: [], default: null }
    const layouts = new Map<string, {activeIndex: number; tabs: {uid: string; id: string | null}[]; revision: number}>()
    const sent: Record<string, string>[] = []
    let finish!: () => void
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url) && (init?.method ?? 'GET') === 'GET') return Response.json({ queued: null })
        const write = url.match(/^\/api\/desktop\/agents\/([^/]+)\/tabs$/)
        if (write) {
            const body = JSON.parse(String(init?.body))
            const layout = { tabs: body.tabs, activeIndex: body.activeIndex, revision: body.baseRevision + 1 }
            layouts.set(write[1], layout)
            return Response.json({ tabs: layout })
        }
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        const list = url.match(/^\/api\/desktop\/agents\/([^/]+)\/sessions$/)
        if (list) return Response.json({ sessions: saved.filter(s => s.agentId === list[1]), tabs: layouts.get(list[1]) ?? null })
        const messages = url.match(/^\/api\/desktop\/sessions\/([^/]+)\/messages$/)
        if (messages && transcripts.has(messages[1])) return Response.json({ messages: transcripts.get(messages[1]) })
        if (url === '/api/desktop/chat' && init?.method === 'POST') {
            const body = JSON.parse(String(init.body))
            sent.push(body)
            const id = body.sessionId ?? 'fresh'
            if (!body.sessionId) saved.unshift(session(id, body.agentId, body.text))
            transcripts.set(id, [{ id, role: 'assistant', parts: [{ type: 'text', text: 'Fresh answer' }] }])
            const encoder = new TextEncoder()
            return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"start","messageId":"fresh-reply"}\n\n'))
                finish = () => { controller.enqueue(encoder.encode('data: {"type":"finish"}\n\ndata: [DONE]\n\n')); controller.close() }
            } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': id } })
        }
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        throw new Error(`Unexpected test request: ${url}`)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    let root = createRoot(container)
    const visible = () => container.querySelector<HTMLElement>('[data-desktop-tab-active="true"]')!
    const openAlice = () => openTile('Alice')
    const history = () => click(`Conversation history (${saved.filter(s => s.agentId === 'alice').length})`)
    const choose = (title: string) => click([...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent?.includes(title))!.textContent!)
    try {
        await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
        await openAlice()
        expect(visible().textContent).toContain('Apples answer')
        await history()
        await choose('Bananas')
        expect(visible().textContent).toContain('Bananas answer')
        expect(visible().textContent).not.toContain('Apples answer')
        await history()
        await choose('Apples')
        expect(visible().textContent).toContain('Apples answer')
        await click('New chat')
        expect(visible().textContent).not.toContain('Apples answer')
        await enter(container.querySelector<HTMLTextAreaElement>('#desktop-message')!, 'Dates')
        await act(async () => { visible().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
        expect(sent).toEqual([{ agentId: 'alice', tabUid: expect.any(String), text: 'Dates' }])
        expect(visible().querySelector<HTMLButtonElement>('[aria-label="Conversation history (3)"]')?.disabled).toBe(false)
        expect(visible().querySelector<HTMLButtonElement>('[aria-label="New chat"]')?.disabled).toBe(false)
        await click('Apples')
        expect(visible().textContent).toContain('Apples answer')
        expect(visible().textContent).not.toContain('Dates answer')
        await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 100)) })
        await click('Dates')
        expect(visible().textContent).toContain('Fresh answer')
        await history()
        expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('Dates')
        await choose('Bananas')
        expect(visible().textContent).toContain('Bananas answer')
        await openTile('Bob')
        expect(visible().textContent).toContain('Carrots answer')
        expect(visible().textContent).not.toMatch(/Fresh answer|Bananas answer|Apples answer/)
        await click('Conversation history (1)')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Carrots')
        expect([...document.querySelectorAll('[role="dialog"] button')].map(button => button.textContent).join(' ')).not.toMatch(/Apples|Bananas|Dates/)
        await click('Conversation history (1)')
        await act(async () => { root.unmount() })
        root = createRoot(container)
        await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
        await openAlice()
        expect(visible().textContent).toContain('Bananas answer')
        await click('Dates')
        expect(visible().textContent).toContain('Fresh answer')
        await history()
        await choose('Apples')
        expect(visible().textContent).toContain('Apples answer')
    } finally { await act(async () => { root.unmount() }) }
})

test('history read failure can be retried without turning it into an empty saved history', async () => {
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url)) return Response.json({ queued: null })
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (url.endsWith('/tabs')) return Response.json({ tabs: { revision: 1 } })
        if (url.endsWith('/saved/messages')) return Response.json({ messages: [] })
        if (url.endsWith('/saved/stop')) return Response.json({ running: false })
        if (url.endsWith('/sessions')) return ++reads === 1 ? Response.json({ error: 'History unavailable' }, { status: 503 }) : Response.json({ sessions: [session('saved', 'alice', 'Recovered')] })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        throw new Error(`Unexpected request: ${url}`)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ theme: 'system', profile: { id: 1, displayName: 'Test' }, workspace: { id: 1, name: 'Test' }, connections: [], default: null,
            agents: [{ id: 'alice', name: 'Alice', description: '', createdAt, updatedAt: createdAt }] }} />) })
        await openTile('Alice')
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('History unavailable')
        await click('Retry conversations')
        expect(container.querySelector('[role="alert"]')).toBeNull()
        await click('Conversation history (1)')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Recovered')
    } finally { await act(async () => { root.unmount() }) }
})
