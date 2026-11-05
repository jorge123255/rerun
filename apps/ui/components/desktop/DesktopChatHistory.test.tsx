// @vitest-environment happy-dom
import { desktopNativeReviewRead } from '@/test/desktop-background-fixture'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { DesktopApp, type DesktopBootstrap, type DesktopSessionView } from './DesktopApp'
import { DesktopChatHistory } from './DesktopChatHistory'
import { groupDesktopChats, type DesktopChatHistoryConversation } from '@/lib/desktop/chat-history'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let drafts: ReturnType<typeof createDesktopDraftFixture>
let recent: ReturnType<typeof createDesktopRecentFixture>
beforeEach(() => { drafts = createDesktopDraftFixture(); recent = createDesktopRecentFixture() })

const createdAt = '2026-01-01T12:00:00.000Z'
const openTile = (name: string) => act(async () => {
    document.querySelector<HTMLElement>(`[aria-label="Open chat with ${name}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
const session = (id: string, agentId: string, title: string): DesktopSessionView => ({ id, agentId, title, createdAt, updatedAt: '2026-11-01T12:00:00.000Z' })
const conversation = (value: DesktopSessionView): DesktopChatHistoryConversation => ({ ...value, engineSessionId: `engine-${value.id}`, source: 'dashboard', needsYou: false, pendingQuestion: null })
const historyOf = (values: DesktopSessionView[]) => ({ conversations: values.map(conversation), enrichment: 'ok', questions: 'ok' })
const inboxOf = (rows: DesktopChatHistoryConversation[]) => ({ items: rows.filter(row => row.needsYou).map(row => ({
    id: `pending-${row.id}`, kind: row.id === 'question' ? 'question' : 'approval', agentId: row.agentId, agentName: 'Alice', agentEnabled: true,
    sessionId: row.id, title: row.title, summary: row.pendingQuestion ?? '', requestedAt: row.createdAt, updatedAt: row.updatedAt,
})), unavailableAgentIds: [], checkedAt: createdAt })
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

test('groups by engine-enriched activity date while leaving its input unchanged', () => {
    const older = { ...conversation(session('old', 'a', 'Older')), updatedAt: createdAt }
    const newer = { ...conversation(session('new', 'a', 'Newer')), updatedAt: '2026-01-02T12:00:00.000Z' }
    const invalid = { ...conversation(session('unknown', 'a', 'Unknown')), updatedAt: '' }
    const input = [older, invalid, newer]
    const groups = groupDesktopChats(input, new Date('2026-01-02T23:00:00.000Z'))
    expect(groups.map(group => group.day)).toEqual(['Today', 'Yesterday', 'Date unavailable'])
    expect(groups.flatMap(group => group.entries.map(entry => entry.id))).toEqual(['new', 'old', 'unknown'])
    expect(input).toEqual([older, invalid, newer])
})

test('browses, searches, marks the active conversation, and disables switching while busy', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const select = vi.fn()
    const sessions = [session('a', 'agent', 'Apple research'), session('b', 'agent', 'Banana research')]
    let listed = sessions
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(historyOf(listed))))
    const render = (busy: boolean, entries = sessions) => act(async () => {
        listed = entries
        root.render(<DesktopChatHistory agentId="agent" count={entries.length} selectedId="a" busy={busy} onSelect={select} />)
    })
    try {
        await render(false)
        await click('Conversation history (2)')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Dates show when chats were last updated.')
        expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('Apple research')
        expect(document.querySelector('time')?.getAttribute('datetime')).toBe(sessions[0].updatedAt)
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
        expect(document.querySelector<HTMLButtonElement>('[aria-current="true"]')?.disabled).toBe(true)
        await render(false, [])
        await click('Conversation history (0)')
        await click('Conversation history (0)')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No conversation yet.')
    } finally { await act(async () => { root.unmount() }) }
})

test('combines the original filters with search and opens the local question or approval conversation', async () => {
    const rows: DesktopChatHistoryConversation[] = [
        { ...conversation(session('question', 'alice', 'Color question')), needsYou: true, pendingQuestion: 'Which color?' },
        { ...conversation(session('approval', 'alice', 'Orange routine')), source: 'schedule', needsYou: true, pendingQuestion: 'Use the orange heading' },
        { ...conversation(session('trigger', 'alice', 'Green routine')), source: 'trigger' },
        conversation(session('ordinary', 'alice', 'Ordinary chat')),
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/desktop/pending-inbox' ? inboxOf(rows) : { conversations: rows, enrichment: 'ok', questions: 'ok' })))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), select = vi.fn()
    const dialog = () => document.querySelector('[role="dialog"]')!
    const needs = () => [...dialog().querySelectorAll('button')].find(button => button.textContent?.startsWith('Needs you'))!
    try {
        await act(async () => { root.render(<DesktopChatHistory agentId="alice" count={4} selectedId="question" busy={false} onSelect={select} />) })
        await click('Conversation history (4)')
        await click('Automations')
        expect(dialog().textContent).toContain('Orange routine')
        expect(dialog().textContent).toContain('Green routine')
        expect(dialog().textContent).not.toContain('Ordinary chat')
        await enter(dialog().querySelector<HTMLInputElement>('input')!, 'Green')
        expect(dialog().textContent).not.toContain('Orange routine')
        await click(needs().textContent!)
        expect(dialog().textContent).toContain('No matching conversations.')
        await enter(dialog().querySelector<HTMLInputElement>('input')!, '')
        expect(dialog().textContent).toContain('Which color?')
        expect(dialog().textContent).toContain('Use the orange heading')
        expect(dialog().textContent).not.toContain('Green routine')
        const approvalRow = [...dialog().querySelectorAll<HTMLElement>('[role="button"]')].find(button => button.textContent?.includes('Orange routine'))!
        await act(async () => { approvalRow.click(); await new Promise(resolve => setTimeout(resolve, 50)) })
        expect(select).toHaveBeenCalledExactlyOnceWith('approval')
    } finally { await act(async () => { root.unmount() }) }
})

test('shows retry states instead of empty filters when classification or pending requests are unavailable', async () => {
    const known = { ...conversation(session('saved', 'alice', 'Saved routine')), source: 'schedule' as const, needsYou: true, pendingQuestion: 'Approve the title' }
    let reads = 0
    let inboxReads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const nativeReview = desktopNativeReviewRead(url); if (nativeReview) return nativeReview
        if (url === '/api/desktop/pending-inbox') return Response.json(++inboxReads === 1 ? { items: [], unavailableAgentIds: ['alice'], checkedAt: createdAt } : inboxOf([known]))
        reads++
        return Response.json(reads === 1
            ? { conversations: [{ ...known, source: null, needsYou: false, pendingQuestion: null }], enrichment: 'unavailable', questions: 'ok' }
            : reads === 2 ? { conversations: [known], enrichment: 'ok', questions: 'unavailable' }
                : { conversations: [known], enrichment: 'ok', questions: 'ok' })
    }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const dialog = () => document.querySelector('[role="dialog"]')!
    try {
        await act(async () => { root.render(<DesktopChatHistory agentId="alice" count={1} selectedId="saved" busy={false} onSelect={() => {}} />) })
        await click('Conversation history (1)')
        expect(dialog().textContent).toContain('Saved routine')
        await click('Automations')
        expect(dialog().textContent).toContain('Conversation types could not be loaded.')
        expect(dialog().textContent).not.toContain('No automated run yet.')
        await click('Retry')
        expect(dialog().textContent).toContain('Saved routine')
        const needs = [...dialog().querySelectorAll('button')].find(button => button.textContent?.startsWith('Needs you'))!
        await click(needs.textContent!)
        expect(dialog().textContent).toContain('Pending requests could not be loaded.')
        expect(dialog().textContent).not.toContain('Nothing waits on you.')
        await click('Retry')
        expect(dialog().textContent).not.toContain('Pending requests could not be loaded.')
        expect(dialog().textContent).toContain('Approve the title')
        expect(reads).toBe(2)
        expect(inboxReads).toBe(2)
    } finally { await act(async () => { root.unmount() }) }
})

test('a delayed old coworker response cannot replace the newly selected coworker’s history', async () => {
    let finishAlice!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/alice/')
        ? new Promise<Response>(resolve => { finishAlice = resolve })
        : Response.json(historyOf([session('bob-chat', 'bob', 'Bob only')]))))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const render = (agentId: string) => act(async () => { root.render(<DesktopChatHistory agentId={agentId} count={1} selectedId={null} busy={false} onSelect={() => {}} />) })
    try {
        await render('alice')
        await click('Conversation history (1)')
        await render('bob')
        await act(async () => { finishAlice(Response.json(historyOf([session('alice-chat', 'alice', 'Alice only')]))); await new Promise(resolve => setTimeout(resolve, 20)) })
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Bob only')
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Alice only')
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
        const nativeReview = desktopNativeReviewRead(url, init); if (nativeReview) return nativeReview
        const recentResponse = recent.handle(url, init)
        if (recentResponse) return recentResponse
        const draftResponse = drafts.handle(url, init)
        if (draftResponse) return draftResponse
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
        const history = url.match(/^\/api\/desktop\/agents\/([^/]+)\/chat-history$/)
        if (history) return Response.json(historyOf(saved.filter(s => s.agentId === history[1])))
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
        const nativeReview = desktopNativeReviewRead(url, init); if (nativeReview) return nativeReview
        const recentResponse = recent.handle(url, init)
        if (recentResponse) return recentResponse
        const draftResponse = drafts.handle(url, init)
        if (draftResponse) return draftResponse
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url)) return Response.json({ queued: null })
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (url.endsWith('/tabs')) return Response.json({ tabs: { revision: 1 } })
        if (url.endsWith('/saved/messages')) return Response.json({ messages: [] })
        if (url.endsWith('/saved/stop')) return Response.json({ running: false })
        if (url.endsWith('/sessions')) return ++reads === 1 ? Response.json({ error: 'History unavailable' }, { status: 503 }) : Response.json({ sessions: [session('saved', 'alice', 'Recovered')] })
        if (url.endsWith('/chat-history')) return Response.json(historyOf([session('saved', 'alice', 'Recovered')]))
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
