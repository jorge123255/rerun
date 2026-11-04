// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { DesktopApp } from './DesktopApp'
import { DesktopFindChat } from './DesktopFindChat'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let drafts: ReturnType<typeof createDesktopDraftFixture>
let recent: ReturnType<typeof createDesktopRecentFixture>
beforeEach(() => { drafts = createDesktopDraftFixture(); recent = createDesktopRecentFixture() })
const hits = [
    { id: 'alice-shared', agentId: 'alice', agentName: 'Alice', title: 'Shared plan' },
    { id: 'bob-shared', agentId: 'bob', agentName: 'Bob', title: 'Shared plan' },
]
const click = (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label)
    expect(button, label).toBeTruthy(); button!.click()
})
const type = (text: string) => act(async () => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search saved chat titles"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
})
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
const select = (name: string) => act(async () => {
    const item = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(item => item.textContent?.includes(name))
    expect(item, name).toBeTruthy(); item!.click()
})
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

test('same-title results open their exact older transcripts, preserve Chats selection, and reopen after remount', async () => {
    const agents = ['Alice', 'Bob'].map(name => ({ id: name.toLowerCase(), name, description: '', createdAt: '', updatedAt: '' }))
    const initial = { theme: 'system' as const, connections: [], default: null, agents, profile: { id: 1, displayName: 'Test' }, workspace: { id: 1, name: 'Disposable' } }
    const reads: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const recentResponse = recent.handle(url, init)
        if (recentResponse) return recentResponse
        const draftResponse = drafts.handle(url, init)
        if (draftResponse) return draftResponse
        if (url.endsWith('/tabs') && init?.method === 'PUT') return Response.json({ tabs: { revision: JSON.parse(String(init.body)).baseRevision + 1 } })
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (url === '/api/desktop/board-activity') return Response.json({ agents: { alice: 'idle', bob: 'idle' } })
        if (url.startsWith('/api/desktop/conversations/search')) return Response.json({ hits: new URL(url, 'http://local').searchParams.get('q') === 'Shared' ? hits : [], hasMore: false })
        const sessions = url.match(/^\/api\/desktop\/agents\/(alice|bob)\/sessions$/)
        if (sessions) { const agentId = sessions[1]; return Response.json({ sessions: [
            { id: `${agentId}-newest`, agentId, title: 'Newer conversation', createdAt: '', updatedAt: '' },
            { id: `${agentId}-shared`, agentId, title: 'Shared plan', createdAt: '', updatedAt: '' },
        ] }) }
        const historyAgent = url.match(/^\/api\/desktop\/agents\/([^/]+)\/chat-history$/)?.[1]
        if (historyAgent) return Response.json({ conversations: [
            { id: `${historyAgent}-newest`, agentId: historyAgent, engineSessionId: `${historyAgent}-engine-new`, title: 'Newer conversation', createdAt: '', updatedAt: '', source: 'dashboard', needsYou: false, pendingQuestion: null },
            { id: `${historyAgent}-shared`, agentId: historyAgent, engineSessionId: `${historyAgent}-engine-shared`, title: 'Shared plan', createdAt: '', updatedAt: '', source: 'dashboard', needsYou: false, pendingQuestion: null },
        ], enrichment: 'ok', questions: 'ok' })
        const messages = url.match(/^\/api\/desktop\/sessions\/([^/]+)\/messages$/)
        if (messages) { reads.push(messages[1]); return Response.json({ messages: [{ id: messages[1], role: 'assistant', parts: [{ type: 'text', text: `Reply for ${messages[1]}` }] }] }) }
        if (url.endsWith('/stop')) return Response.json({ running: false })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        throw new Error(`Unexpected request ${url}`)
    }))
    const container = document.createElement('div'); document.body.append(container)
    let root = createRoot(container)
    const search = async () => { await click('Find chat'); await type('Shared'); await settle() }
    try {
        await act(async () => { root.render(<DesktopApp initialData={initial} />) })
        for (const name of ['Alice', 'Bob']) {
            await search()
            expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Alice')
            expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Bob')
            await select(name)
            expect(container.textContent).toContain(`Reply for ${name.toLowerCase()}-shared`)
            expect(container.textContent).not.toContain(`Reply for ${name.toLowerCase()}-newest`)
            await click('Close panel')
        }
        expect(reads).toEqual(['alice-shared', 'bob-shared'])
        await act(async () => { container.querySelector<HTMLElement>('[aria-label="Open chat with Alice"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(container.textContent).toContain('Reply for alice-newest')
        const history = () => container.querySelector<HTMLButtonElement>('[aria-label="Conversation history (2)"]')!
        await act(async () => { history().click() })
        await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes('Shared plan'))!.click() })
        expect(container.textContent).toContain('Reply for alice-shared')
        await click('Close panel')
        await click('Find chat'); await type('missing'); await settle()
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No matching chats.')
        await act(async () => { root.unmount() })
        root = createRoot(container)
        await act(async () => { root.render(<DesktopApp initialData={initial} />) })
        for (const name of ['Alice', 'Bob']) {
            await search(); await select(name)
            expect(container.textContent).toContain(`Reply for ${name.toLowerCase()}-shared`)
            await click('Close panel')
        }
    } finally { await act(async () => { root.unmount() }) }
})

test('debounces, aborts stale queries, reports failures distinctly and retries', async () => {
    let finish!: (response: Response) => void
    const slow = new Promise<Response>(resolve => { finish = resolve })
    const fetcher = vi.fn().mockImplementationOnce(() => slow).mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValue(Response.json({ hits: [], hasMore: false }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopFindChat onSelect={vi.fn()} />) })
        await click('Find chat')
        await type('S'); await settle(); expect(fetcher).not.toHaveBeenCalled()
        await type('Sh'); await type('Shared'); await settle(); expect(fetcher).toHaveBeenCalledTimes(1)
        await type('Other'); await settle()
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not search saved chats')
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('No matching chats.')
        await act(async () => { finish(Response.json({ hits, hasMore: false })) })
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Shared plan')
        await click('Retry search'); await settle()
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No matching chats.')
    } finally { await act(async () => { root.unmount() }) }
})

test('a stale search selection never falls back to the coworker’s newest conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const recentResponse = recent.handle(url, init)
        if (recentResponse) return recentResponse
        const draftResponse = drafts.handle(url, init)
        if (draftResponse) return draftResponse
        if (url.endsWith('/tabs') && init?.method === 'PUT') return Response.json({ tabs: { revision: JSON.parse(String(init.body)).baseRevision + 1 } })
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (url === '/api/desktop/board-activity') return Response.json({ agents: { alice: 'idle' } })
        if (url.includes('/search?')) return Response.json({ hits: [hits[0]], hasMore: false })
        if (url.endsWith('/sessions')) return Response.json({ sessions: [{ id: 'alice-newest', agentId: 'alice', title: 'Newest', createdAt: '', updatedAt: '' }] })
        if (url.includes('/model') || url.endsWith('/stop')) return Response.json(url.includes('/model') ? { catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } } : { running: false })
        throw new Error(`Unexpected request ${url}`)
    }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ theme: 'system', connections: [], default: null,
            agents: [{ id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }], profile: { id: 1, displayName: 'Test' }, workspace: { id: 1, name: 'Test' } }} />) })
        await click('Find chat'); await type('Shared'); await settle(); await select('Alice')
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('no longer available')
        expect(container.querySelector('#desktop-message')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('keyboard selection distinguishes duplicate titles by conversation ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hits, hasMore: false })))
    const onSelect = vi.fn()
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopFindChat onSelect={onSelect} />) })
        await click('Find chat'); await type('Shared'); await settle()
        const input = document.querySelector<HTMLInputElement>('[aria-label="Search saved chat titles"]')!
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
        const selected = document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute('data-value')
        expect(selected).toBe('bob-shared')
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(hits[1])
    } finally { await act(async () => { root.unmount() }) }
})
