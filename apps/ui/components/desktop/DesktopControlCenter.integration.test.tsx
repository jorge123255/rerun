// @vitest-environment happy-dom

import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hashText } from '@/lib/files/editable'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import { DesktopApp } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
    .find(dialog => dialog.querySelector('input[placeholder="Search coworkers, settings, conversations…"]'))
const activeChat = () => document.querySelector<HTMLElement>('[data-desktop-tab-active="true"]')!
const composer = () => activeChat()?.querySelector<HTMLTextAreaElement>('#desktop-message')!
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

async function mount() {
    const drafts = createDesktopDraftFixture()
    const agents = [agent('alice', 'Alice'), agent('bob', 'Bob')]
    const layouts = new Map<string, DesktopTabLayout>()
    const reads: string[] = [], created: unknown[] = [], fileWrites: unknown[] = []
    let recent = { revision: 0, recentAgentIds: [] as string[] }
    for (const owner of agents) {
        const tabs = [{ uid: `${owner.id}-draft-tab`, id: `${owner.id}-draft`, title: 'Draft chat' }]
        layouts.set(owner.id, { revision: 0, activeIndex: 0, tabs })
        drafts.seedTabs(owner.id, tabs)
    }
    const sessionsFor = (id: string) => agents.some(owner => owner.id === id) && id !== 'casey' ? [
        { id: `${id}-draft`, agentId: id, title: 'Draft chat', createdAt: date, updatedAt: date },
        { id: `${id}-shared`, agentId: id, title: 'Shared plan', createdAt: date, updatedAt: date },
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
        if (url.pathname === '/api/desktop/attention') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === '/api/desktop/conversations/search') return Response.json({ hits: url.searchParams.get('q') === 'shared' ? hits : [], hasMore: false })
        if (url.pathname === '/api/desktop/agents' && method === 'POST') {
            const body = JSON.parse(String(init?.body))
            created.push(body)
            const coworker = { ...agent('casey', body.name), description: body.description }
            agents.push(coworker)
            return Response.json({ agent: coworker }, { status: 201 })
        }
        const ownerRoute = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/(sessions|tabs|model|queue|files(?:\/read|\/content)?)$/)
        if (ownerRoute) {
            const [, owner, resource] = ownerRoute
            if (resource === 'sessions') return Response.json({ sessions: sessionsFor(owner), tabs: layouts.get(owner) ?? null })
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
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<DesktopApp initialData={{ ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Fixture workspace' }, agents: [...agents] }} />) })
    return { container, layouts, reads, created, fileWrites, fetcher }
}

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
    expect(app.layouts.get('alice')?.tabs).toHaveLength(2)
    expect(app.layouts.get('alice')?.tabs[app.layouts.get('alice')!.activeIndex].id).toBeNull()
    await enterText(composer(), 'The new chat has another draft')
    await click('Draft chat', app.container.querySelector('[aria-label="Open conversations"]')!)
    expect(composer().value).toBe('Keep the first chat draft')
    await shortcut('f', composer())
    expect(center()).toBeDefined()
})

test('Control center commands reach real model settings, the board, and coworker creation', async () => {
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
    await enterText(dialog.querySelector<HTMLInputElement>('#coworker-name')!, 'Casey')
    await enterText(dialog.querySelector<HTMLTextAreaElement>('#coworker-description')!, 'Keep track of notes')
    await click('Create coworker', dialog)
    expect(app.created).toEqual([{ name: 'Casey', description: 'Keep track of notes' }])
    expect(app.container.querySelector('[aria-label="Open chat with Casey"]')).not.toBeNull()
    await until(() => composer())
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
