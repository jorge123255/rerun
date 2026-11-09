// @vitest-environment happy-dom

import { EditorView } from '@codemirror/view'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hashText } from '@/lib/files/editable'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { generalTabUid, isGeneralTab } from '@/lib/desktop/general-threads'
import type { DesktopCompletionItem } from '@/lib/desktop/completed-actions'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import { DesktopApp } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep real App, board, Control Center and chat behavior while excluding happy-dom's
// incomplete Web Animation cancellation, which rejects when a panel switches rapidly.
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
    return { ...actual,
        AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
        motion: new Proxy(actual.motion, { get(target, key, receiver) {
            if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
            return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
        } }),
    }
})

const date = '2026-11-04T12:00:00.000Z'
const agent = (id: string, name: string) => ({ id, name, description: '', enabled: true, createdAt: date, updatedAt: date })
const hits = [
    { id: 'alice-shared', agentId: 'alice', agentName: 'Alice', title: 'Shared plan' },
    { id: 'bob-shared', agentId: 'bob', agentName: 'Bob', title: 'Shared plan' },
]
const providers = { connections: [{ id: 'fixture-openai', name: 'Fixture OpenAI', provider: 'openai' as const,
    models: ['gpt-4o-mini'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: date }],
    default: { connectionId: 'fixture-openai', model: 'gpt-4o-mini' } }
const roots: ReturnType<typeof createRoot>[] = []
const unexpected: string[] = []

beforeEach(() => {
    resetDesktopRecentCoworkers()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    resetDesktopRecentCoworkers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    expect(unexpected.splice(0)).toEqual([])
})

const center = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find(dialog => dialog.querySelector('input[cmdk-input]'))
const activeChat = () => document.querySelector<HTMLElement>('[data-desktop-tab-active="true"]')!
const composer = () => activeChat().querySelector<HTMLTextAreaElement>('#desktop-message')!
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function until<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 75; attempt++) {
        const result = read()
        if (result) return result
        await settle(20)
    }
    throw new Error('Expected UI did not appear')
}
async function click(label: string, scope: ParentNode = document) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    await act(async () => { button!.click() })
}
async function enterText(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
    expect(input).toBeTruthy()
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
}
async function shortcut(key: string, target: EventTarget = window) {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })) })
}
async function query(text: string) {
    const input = center()?.querySelector<HTMLInputElement>('input')
    expect(input).toBeDefined()
    await enterText(input!, text)
    await settle(300)
}
async function pick(value: string) {
    const row = [...(center()?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])].find(item => item.getAttribute('data-value') === value)
    expect(row, value).toBeDefined()
    await act(async () => { row!.click() })
}
async function openCoworker(name = 'Alice') {
    await shortcut('f')
    await query(name)
    const input = center()!.querySelector<HTMLInputElement>('input')!
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await until(() => composer())
}

async function mount(completed: DesktopCompletionItem[] = [], lateShared = false) {
    let sharedAvailable = !lateShared
    const drafts = createDesktopDraftFixture()
    const agents = [agent('alice', 'Alice'), agent('bob', 'Bob')]
    const layouts = new Map<string, DesktopTabLayout>()
    const reads: string[] = [], created: unknown[] = [], fileWrites: unknown[] = []
    const marked: string[][] = [], seen = new Set<string>()
    let recent = { revision: 0, recentAgentIds: [] as string[] }
    for (const owner of agents) {
        const tabs = [{ uid: `${owner.id}-draft-tab`, id: `${owner.id}-draft`, title: 'Draft chat' }]
        layouts.set(owner.id, { revision: 0, activeIndex: 0, tabs })
        drafts.seedTabs(owner.id, tabs)
    }
    const sessionsFor = (id: string) => agents.some(owner => owner.id === id) && id !== 'casey' ? [
        { id: `${id}-draft`, agentId: id, title: 'Draft chat', createdAt: date, updatedAt: date },
        ...(sharedAvailable ? [{ id: `${id}-shared`, agentId: id, title: 'Shared plan', createdAt: date, updatedAt: date }] : []),
    ] : []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const url = new URL(raw, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init)
        if (draft) return draft
        if (url.pathname === '/api/desktop/recent-coworkers' && method === 'POST') {
            const body = JSON.parse(String(init?.body))
            if (body.baseRevision !== recent.revision) return Response.json({ error: 'Changed', recent }, { status: 409 })
            recent = { revision: recent.revision + 1, recentAgentIds: [body.agentId, ...recent.recentAgentIds.filter(id => id !== body.agentId)].slice(0, 5) }
            return Response.json(recent)
        }
        if (url.pathname === '/api/desktop/settings' && method === 'GET') return Response.json(providers)
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: Object.fromEntries(agents.map(owner => [owner.id, 'idle'])) })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: completed.filter(item => !item.completionIds.every(id => seen.has(id))), unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/completions/read' && method === 'POST') {
            const { completionIds } = JSON.parse(String(init?.body)) as { completionIds: string[] }
            marked.push(completionIds)
            completionIds.forEach(id => seen.add(id))
            return Response.json({ marked: completionIds.length })
        }
        if (url.pathname === '/api/desktop/conversations/search') return Response.json({ hits: url.searchParams.get('q') === 'shared' ? hits : [], hasMore: false })
        if (url.pathname === '/api/desktop/agents' && method === 'POST') {
            const body = JSON.parse(String(init?.body))
            created.push(body)
            const coworker = { ...agent('casey', body.name), description: body.description }
            agents.push(coworker)
            return Response.json({ agent: coworker }, { status: 201 })
        }
        const ownerRoute = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/(sessions|tabs|control-center-chats|model|queue|files(?:\/read|\/content)?)$/)
        if (ownerRoute) {
            const [, owner, resource] = ownerRoute
            if (resource === 'sessions') return Response.json({ sessions: sessionsFor(owner), tabs: layouts.get(owner) ?? null })
            if (resource === 'control-center-chats') {
                const openChats = (layouts.get(owner)?.tabs ?? []).map(tab => ({
                    agentId: owner, tabUid: tab.uid, sessionId: tab.id, title: isGeneralTab(tab) ? 'General' : tab.title,
                    kind: isGeneralTab(tab) ? 'general' : 'thread', firstMessage: null,
                }))
                const recentChats = sessionsFor(owner).filter(session => !openChats.some(tab => tab.sessionId === session.id))
                    .map(session => ({ id: session.id, agentId: owner, agentName: agents.find(agent => agent.id === owner)!.name, title: session.title }))
                return Response.json({ agentId: owner, openChats, recentChats, recentStatus: 'ok', hasMore: false })
            }
            if (resource === 'tabs' && method === 'PUT') {
                const body = JSON.parse(String(init?.body))
                const layout = { revision: body.baseRevision + 1, activeIndex: body.activeIndex,
                    tabs: body.tabs.map((tab: { uid: string; id: string | null }) => ({ ...tab, title: sessionsFor(owner).find(session => session.id === tab.id)?.title ?? 'New conversation' })) }
                layouts.set(owner, layout)
                return Response.json({ tabs: layout })
            }
            if (resource === 'model') return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null,
                effective: { source: 'workspace', connectionId: 'fixture-openai', provider: 'openai', name: 'Fixture OpenAI', model: 'gpt-4o-mini', label: 'Fixture model', available: true } })
            if (resource === 'queue') return Response.json({ queued: null })
            if (resource === 'files') return Response.json({ path: '', entries: [{ name: 'notes.md', type: 'file', size: 12, modifiedAt: date, identity: '1:2' }] })
            if (resource === 'files/read') return Response.json({ path: 'notes.md', content: 'Saved notes.', hash: hashText('Saved notes.'), identity: '1:2', truncated: false })
            if (resource === 'files/content') { fileWrites.push(JSON.parse(String(init?.body))); return Response.json({ error: 'This fixture must not save the file.' }, { status: 409 }) }
        }
        const sessionRoute = url.pathname.match(/^\/api\/desktop\/sessions\/([^/]+)\/(messages|questions|approvals|stop|feedback)$/)
        if (sessionRoute && method === 'GET') {
            const [, session, resource] = sessionRoute
            if (resource === 'messages') { reads.push(session); return Response.json({ messages: [{ id: `reply-${session}`, role: 'assistant', parts: [{ type: 'text', text: `Reply for ${session}` }] }] }) }
            if (resource === 'questions') return Response.json({ question: null })
            if (resource === 'approvals') return Response.json({ approval: null })
            if (resource === 'stop') return Response.json({ running: false })
            if (resource === 'feedback') return Response.json({ votes: [] })
        }
        const background = desktopBackgroundRead(input, init); if (background) return background
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<DesktopApp initialData={{ ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Fixture workspace' }, agents: [...agents] }} />) })
    return { container, layouts, reads, created, fileWrites, fetcher, marked, publishShared: () => { sharedAvailable = true } }
}

test('opening a newly adopted background chat refreshes sessions without remounting tabs or losing a newer draft', async () => {
    const app = await mount([], true)
    await openCoworker('Alice')
    await enterText(composer(), 'Keep the original draft')
    const original = composer()
    await shortcut('k', composer())
    await enterText(composer(), 'Keep the newer unsent tab')
    const blank = composer()
    const blankUid = app.layouts.get('alice')!.tabs.find(tab => tab.id === null && !isGeneralTab(tab))!.uid
    const revision = app.layouts.get('alice')!.revision
    app.publishShared()
    await shortcut('f'); await query('Shared'); await pick('conversations-conversation-alice-shared')
    await until(() => activeChat()?.textContent?.includes('Reply for alice-shared'))
    expect(original.isConnected).toBe(true)
    expect(blank.isConnected).toBe(true)
    expect(blank.value).toBe('Keep the newer unsent tab')
    expect(app.layouts.get('alice')!.revision).toBeGreaterThan(revision)
    expect(app.layouts.get('alice')!.tabs.some(tab => tab.uid === blankUid && tab.id === null)).toBe(true)
    expect(app.container.textContent).not.toContain('no longer available')
    await click('Draft chat', app.container.querySelector('[aria-label="Open conversations"]')!)
    expect(composer()).toBe(original)
    expect(composer().value).toBe('Keep the original draft')
})

test('an unavailable saved target reports the refreshed result without discarding the current draft or looping', async () => {
    const app = await mount([], true)
    await openCoworker('Alice')
    await enterText(composer(), 'Keep this chat when the search result is stale')
    const original = composer()
    await shortcut('f'); await query('Shared'); await pick('conversations-conversation-alice-shared')
    await until(() => app.container.textContent?.includes('This conversation is no longer available'))
    expect(original.isConnected).toBe(true)
    expect(original.value).toBe('Keep this chat when the search result is stale')
    const reads = () => app.fetcher.mock.calls.filter(([input]) => String(input) === '/api/desktop/agents/alice/sessions').length
    expect(reads()).toBe(2)
    await settle(30)
    expect(reads()).toBe(2)
    expect(app.layouts.get('alice')!.tabs.map(({ uid, id }) => [uid, id])).toEqual([
        [generalTabUid('alice'), null], ['alice-draft-tab', 'alice-draft'],
    ])
})

test('the actual visible saved tab acknowledges only its completions while the inbox is closed, and a Done row opens its own coworker', async () => {
    const completion = (owner: string): DesktopCompletionItem => ({ id: `done:${owner}-draft`, agentId: owner, agentName: owner === 'alice' ? 'Alice' : 'Bob', agentEnabled: true,
        sessionId: `${owner}-draft`, sessionIds: [`${owner}-draft`], title: 'Draft chat', message: `${owner} completed reply`, source: 'chat', slug: null, count: 1,
        completedAt: date, completionIds: [`${owner}-terminal`] })
    const app = await mount([completion('alice'), completion('bob')])
    const board = app.container.querySelector('[aria-label="Team board"]')
    await openCoworker('Alice')
    await until(() => app.marked.some(ids => ids.includes('alice-terminal')))
    expect(app.marked.flat()).toEqual(['alice-terminal'])
    expect(document.querySelector('[aria-label="Actions inbox"]')).toBeNull()
    await enterText(composer(), 'Keep Alice draft while opening Bob completion')
    await shortcut('k', composer())
    await enterText(composer(), 'Keep the separate blank draft too')
    const actions = [...app.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label')?.startsWith('Actions:'))!
    await act(async () => { actions.click() })
    const done = await until(() => document.querySelector<HTMLElement>('[data-actions-inbox-done="done:bob-draft"]'))
    await act(async () => { done.click() })
    await until(() => activeChat()?.textContent?.includes('Reply for bob-draft'))
    expect(app.marked.flat()).toEqual(['alice-terminal', 'bob-terminal'])
    expect(activeChat().textContent).not.toContain('Reply for alice-draft')
    await openCoworker('Alice')
    expect(composer().value).toBe('Keep the separate blank draft too')
    await click('Draft chat', app.container.querySelector('[aria-label="Open conversations"]')!)
    expect(composer().value).toBe('Keep Alice draft while opening Bob completion')
    await click('Close panel')
    expect(app.container.querySelector('[aria-label="Team board"]')).toBe(board)
})

test('workspace entry opens exact same-title chats without replacing another chat draft or remounting the board', async () => {
    const app = await mount()
    const board = app.container.querySelector('[aria-label="Team board"]')
    await openCoworker()
    await enterText(composer(), 'Alice draft stays in its own chat')
    const workspaceMenu = app.container.querySelector<HTMLButtonElement>('[aria-label="Workspace menu, Fixture workspace"]')!
    await act(async () => {
        workspaceMenu.focus()
        workspaceMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Control center')
    expect(entry).toBeDefined()
    await act(async () => { entry!.click() })
    await until(center)
    await query('Shared')
    expect(app.fetcher.mock.calls.some(([input]) => String(input) === '/api/desktop/conversations/search?q=shared')).toBe(true)
    expect(center()!.textContent).toContain('Alice')
    expect(center()!.textContent).toContain('Bob')
    await pick('conversations-conversation-alice-shared')
    expect(activeChat().textContent).toContain('Reply for alice-shared')
    expect(activeChat().textContent).not.toContain('Reply for alice-draft')
    expect(composer().value).toBe('')
    await shortcut('f'); await query('Shared'); await pick('conversations-conversation-bob-shared')
    expect(activeChat().textContent).toContain('Reply for bob-shared')
    expect(activeChat().textContent).not.toContain('Reply for bob-draft')
    expect(composer().value).toBe('')
    await openCoworker('Alice')
    await click('Draft chat', app.container.querySelector('[aria-label="Open conversations"]')!)
    expect(activeChat().textContent).toContain('Reply for alice-draft')
    expect(composer().value).toBe('Alice draft stays in its own chat')
    expect(app.reads).toContain('alice-shared')
    expect(app.reads).toContain('bob-shared')
    expect(app.reads).not.toContain('bob-draft')
    await click('Close panel')
    expect(app.container.querySelector('[aria-label="Team board"]')).toBe(board)
})

test('Enter opens the coworker and Cmd K inside its chat creates a separate draft tab', async () => {
    const app = await mount()
    await openCoworker()
    expect(center()).toBeUndefined()
    expect(activeChat().textContent).toContain('Reply for alice-draft')
    await enterText(composer(), 'Keep the first chat draft')
    await shortcut('k', composer())
    expect(center()).toBeUndefined()
    expect(composer().value).toBe('')
    expect(app.layouts.get('alice')?.tabs).toHaveLength(3)
    expect(app.layouts.get('alice')?.tabs[app.layouts.get('alice')!.activeIndex].id).toBeNull()
    await enterText(composer(), 'The new chat has another draft')
    await click('Draft chat', app.container.querySelector('[aria-label="Open conversations"]')!)
    expect(composer().value).toBe('Keep the first chat draft')
    await shortcut('f', composer())
    expect(center()).toBeDefined()
})

test('coworker drill opens the exact unsent draft and moves recent chats into open tabs without cross-owner replies or duplicates', async () => {
    const app = await mount()
    const board = app.container.querySelector('[aria-label="Team board"]')
    async function drill(name: string) {
        await shortcut('f')
        await query(`@${name}`)
        const input = center()!.querySelector<HTMLInputElement>('input')!
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
        await until(() => center()?.querySelector('[data-value^="open-chat-"]'))
    }
    await openCoworker()
    await enterText(composer(), 'Alice saved chat draft')
    await shortcut('k', composer())
    const blankUid = app.layouts.get('alice')!.tabs.find(tab => tab.id === null && !isGeneralTab(tab))!.uid
    await enterText(composer(), 'Alice unsent new chat draft')
    await click('Draft chat', app.container.querySelector('[aria-label="Open conversations"]')!)
    await drill('Alice')
    expect(center()!.textContent).toContain('Open chats')
    expect(center()!.textContent).toContain('Recent conversations')
    await pick(`open-chat-${blankUid}`)
    await until(() => !center())
    expect(composer().value).toBe('Alice unsent new chat draft')
    expect(activeChat().textContent).not.toContain('Reply for alice-draft')
    expect(app.layouts.get('alice')!.tabs).toHaveLength(3)
    await drill('Alice')
    await pick('recent-chat-alice-shared')
    await until(() => activeChat()?.textContent?.includes('Reply for alice-shared'))
    expect(composer().value).toBe('')
    expect(app.layouts.get('alice')!.tabs).toHaveLength(4)
    await drill('Alice')
    expect(center()!.querySelector('[data-value="recent-chat-alice-shared"]')).toBeNull()
    const shared = app.layouts.get('alice')!.tabs.find(tab => tab.id === 'alice-shared')!
    await pick(`open-chat-${shared.uid}`)
    await until(() => !center())
    expect(app.layouts.get('alice')!.tabs).toHaveLength(4)
    await drill('Bob')
    await pick('recent-chat-bob-shared')
    await until(() => activeChat()?.textContent?.includes('Reply for bob-shared'))
    expect(activeChat().textContent).not.toContain('Reply for alice-shared')
    expect(app.reads).not.toContain('bob-draft')
    await drill('Alice')
    await pick(`open-chat-${blankUid}`)
    await until(() => !center())
    expect(composer().value).toBe('Alice unsent new chat draft')
    await drill('Alice')
    await pick('open-chat-alice-draft-tab')
    await until(() => !center())
    expect(composer().value).toBe('Alice saved chat draft')
    await click('Close panel')
    expect(app.container.querySelector('[aria-label="Team board"]')).toBe(board)
})

test('Control center commands reach real model settings, the board, and the original coworker description dialog', async () => {
    const app = await mount()
    const board = app.container.querySelector('[aria-label="Team board"]')
    await openCoworker()
    await shortcut('f'); await query('/ model'); await pick('command-model_settings')
    expect(app.container.querySelector('#desktop-api-key')).not.toBeNull()
    await shortcut('f')
    expect(center()).toBeUndefined()
    await click('Back to chat')
    await shortcut('f'); await query('/ team'); await pick('command-team_board')
    const panel = app.container.querySelector('[aria-label="Coworker chat"]')
    expect(panel === null || panel.closest('[inert]') !== null).toBe(true)
    expect(app.container.querySelector('[aria-label="Team board"]')).toBe(board)
    await shortcut('k'); await query('/ add'); await pick('command-add_coworker')
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(item => item.textContent?.includes('Add a coworker'))!
    expect(dialog).toBeDefined()
    expect(dialog.querySelector('textarea')).not.toBeNull()
    expect(dialog.textContent).toContain('first message after you place it on the board')
    expect(app.created).toEqual([])
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await until(() => !document.querySelector('[role="dialog"]'))
    expect(app.created).toEqual([])
    expect(app.container.querySelector('[aria-label="Team board"]')).toBe(board)
})

test('Control center shortcuts cannot cover or discard the real Files editor and its unsaved-change confirmation', async () => {
    const app = await mount()
    await openCoworker()
    await click('Files')
    await click('notes.md')
    await until(() => document.querySelector('[data-testid="file-preview"]'))
    await click('Edit')
    // Use the actual CodeMirror transaction and the actual Files/ConfirmDialog components.
    // No editor or control-center implementation is replaced by a mock in this suite.
    const content = await until(() => document.querySelector<HTMLElement>('.cm-content'))
    const editor = EditorView.findFromDOM(content)!
    expect(editor).toBeDefined()
    await act(async () => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'Unsaved file draft must survive' } }) })
    const layoutBefore = JSON.stringify(app.layouts.get('alice'))
    await shortcut('f', content)
    await shortcut('k', content)
    expect(center()).toBeUndefined()
    expect(editor.state.doc.toString()).toBe('Unsaved file draft must survive')
    expect(JSON.stringify(app.layouts.get('alice'))).toBe(layoutBefore)
    await click('Close editor')
    const confirmation = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(confirmation?.textContent).toContain('Discard your changes?')
    await shortcut('f', confirmation)
    await shortcut('k', confirmation)
    expect(center()).toBeUndefined()
    expect(document.querySelector('[role="alertdialog"]')).toBe(confirmation)
    await click('Keep editing', confirmation)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(editor.state.doc.toString()).toBe('Unsaved file draft must survive')
    expect(JSON.stringify(app.layouts.get('alice'))).toBe(layoutBefore)
    expect(app.fileWrites).toEqual([])
})
