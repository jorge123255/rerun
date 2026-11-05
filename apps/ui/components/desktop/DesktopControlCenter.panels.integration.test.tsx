// @vitest-environment happy-dom
// Authored without execution. Root owns all test runs and native acceptance.
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { DesktopApp, type DesktopBootstrap } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }) }))

// Preserve App, the board, tab state, conversations, original command rows and real dialogs.
// Only remove the animation driver that happy-dom cannot finish safely on dialog teardown.
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

const date = '2026-11-04T12:00:00.000Z'
const providers = { connections: [], default: null }
const reviewer = { id: 'panel-reviewer', name: 'Reviewer', description: 'Reviews', enabled: true, createdAt: date, updatedAt: date }
const auditor = { id: 'panel-auditor', name: 'Auditor', description: 'Audits', enabled: true, createdAt: date, updatedAt: date }
const coworkers = [reviewer, auditor]
const roots = new Set<ReturnType<typeof createRoot>>()
const unexpected: string[] = []

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
})
afterEach(async () => {
    await act(async () => { for (const root of roots) root.unmount() })
    roots.clear()
    document.body.innerHTML = ''
    cancelDraftShutdown()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    expect(unexpected.splice(0)).toEqual([])
})

const commandField = () => document.querySelector<HTMLInputElement>('[cmdk-input]')
const composer = () => document.querySelector<HTMLTextAreaElement>('[data-desktop-tab-active="true"] textarea[id^="desktop-message"]')
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function until<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 80; attempt++) {
        const result = read()
        if (result) return result
        await settle(20)
    }
    throw new Error('Expected coworker navigation UI did not appear')
}
async function click(label: string, scope: ParentNode = document) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    await act(async () => { button!.click() })
}
async function enter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
}
async function openCoworkerPage(name: string) {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })) })
    const input = await until(commandField)
    await enter(input, `@${name}`)
    await until(() => document.querySelector('[cmdk-item][data-selected="true"]')?.textContent?.includes(name))
    // The original Tab drill gesture keeps focus in the search field.
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    await until(() => commandField()?.placeholder === `Search in ${name}…`)
}
async function chooseOpenRow(label: string) {
    const row = await until(() => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
        .find(item => [...item.querySelectorAll('span')].some(span => span.textContent === label)))
    await act(async () => { row.click() })
    await until(() => !commandField())
}
function panelDialog(title: string) {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .find(dialog => [...dialog.querySelectorAll('h1,h2,h3')].some(heading => heading.textContent === title))
}
async function dismissPanel(title: string) {
    const dialog = await until(() => panelDialog(title))
    if (title === 'Monitoring') await click('Close', dialog)
    else await click(title === 'Edit coworker' ? 'Cancel' : 'Done', dialog)
    await until(() => !panelDialog(title))
}

function fixture(runStatus?: () => Promise<Response>) {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const layouts = new Map<string, DesktopTabLayout>(coworkers.map(agent => [agent.id, {
        revision: 0, activeIndex: 0, tabs: [
            { uid: `${agent.id}-first-tab`, id: `${agent.id}-first`, title: `${agent.name} first chat` },
            { uid: `${agent.id}-second-tab`, id: `${agent.id}-second`, title: `${agent.name} second chat` },
        ],
    }]))
    for (const agent of coworkers) drafts.seedTabs(agent.id, layouts.get(agent.id)!.tabs)
    const panelReads: string[] = []
    const messageReads: string[] = []
    const contentWrites: string[] = []
    const sessions = (agentId: string) => layouts.get(agentId)!.tabs.map(tab => ({
        id: tab.id!, agentId, title: tab.title, createdAt: date, updatedAt: date,
    }))
    const answer = (sessionId: string) => `Saved answer belonging to ${sessionId}.`

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const url = new URL(raw, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init)
        if (draft) return draft
        const recentResponse = recent.handle(input, init)
        if (recentResponse) return recentResponse
        if (url.pathname === '/api/desktop/settings' && method === 'GET') return Response.json(providers)
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: Object.fromEntries(coworkers.map(agent => [agent.id, 'idle'])) })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === '/api/desktop/conversations/search') return Response.json({ hits: [], hasMore: false })
        const agentRoute = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/(.+)$/)
        if (agentRoute) {
            const agentId = decodeURIComponent(agentRoute[1])
            const agent = coworkers.find(item => item.id === agentId)
            const route = agentRoute[2]
            if (!agent) throw new Error(`Unknown fixture coworker ${agentId}`)
            if (route === 'sessions') return Response.json({ sessions: sessions(agentId), tabs: layouts.get(agentId) })
            if (route === 'tabs' && method === 'PUT') {
                const body = JSON.parse(String(init?.body))
                const titles = new Map(layouts.get(agentId)!.tabs.map(tab => [tab.uid, tab.title]))
                const next: DesktopTabLayout = { revision: body.baseRevision + 1, activeIndex: body.activeIndex,
                    tabs: body.tabs.map((tab: { uid: string; id: string | null }) => ({ ...tab, title: titles.get(tab.uid) ?? 'New conversation' })) }
                layouts.set(agentId, next)
                return Response.json({ tabs: next })
            }
            if (route === 'control-center-chats') return Response.json({ agentId, openChats: layouts.get(agentId)!.tabs.map(tab => ({
                agentId, tabUid: tab.uid, sessionId: tab.id, title: tab.title,
            })), recentChats: [], recentStatus: 'ok', hasMore: false })
            if (['files', 'files/read', 'memories', 'tools', 'monitoring', 'runs', 'settings', 'skills', 'skills/proposals'].includes(route)) {
                panelReads.push(url.pathname)
                if (method !== 'GET') contentWrites.push(`${method} ${url.pathname}`)
                if (route === 'skills') return Response.json({ skills: [] })
                if (route === 'skills/proposals') return Response.json({ availability: 'complete', proposals: [] })
                if (route === 'runs') return Response.json({ runs: [{ id: `${agentId}-run`, status: 'done', startedAt: date, finishedAt: date, stepCount: 1, provider: 'mac-chatgpt', model: `${agent.name} model`, inputTokens: null, outputTokens: null, totalTokens: 42, cachedInputTokens: null, reasoningTokens: null, costMicros: null }] })
                if (route === 'files') return Response.json({ path: '', entries: [{ name: 'notes.md', type: 'file', size: 32, modifiedAt: date }] })
                if (route === 'files/read') return Response.json({ path: 'notes.md', content: `# ${agent.name} private file`, size: 32, truncated: false })
                if (route === 'memories') return Response.json({ memories: [{ id: `${agentId}-note`, content: `${agent.name} private memory`, kind: 'fact', tags: [], createdAt: date, strength: 1, status: 'active' }] })
                if (route === 'tools') return Response.json({ rerun: [{ id: 'workspaceRead', label: `${agent.name} file access`, description: 'Read own workspace files', tools: ['fs_read'], enabled: false, available: true }], codex: [] })
                if (route === 'monitoring') return Response.json({ agentId, range: url.searchParams.get('range'), runs: [], errorRate: [], runsByStatus: [], runsByModel: [], totalTokens: null, cost: null, avgDuration: [], toolCalls: [], toolErrors: [] })
                if (route === 'settings') return Response.json({ soul: `${agent.name} private instructions`, verbosity: 'normal', soulEditable: true, workspaceReadEnabled: false, suggestedReplies: false, memoryEnabled: false, autoMemory: false, selfImprovementEnabled: true })
            }
        }
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.pathname.endsWith('/messages')) {
            messageReads.push(url.pathname)
            const id = decodeURIComponent(url.pathname.split('/')[4])
            return Response.json({ messages: [{ id: `${id}-answer`, role: 'assistant', parts: [{ type: 'text', text: answer(id) }] }] })
        }
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/stop') && method === 'GET') return runStatus ? runStatus() : Response.json({ running: false })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        const background = desktopBackgroundRead(input, init); if (background) return background
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    }))
    return {
        panelReads, messageReads, contentWrites, layouts, answer,
        async mount() {
            const container = document.createElement('div')
            document.body.append(container)
            const root = createRoot(container)
            roots.add(root)
            const initialData: DesktopBootstrap = { ...providers, theme: 'dark', profile: { id: 1, displayName: 'Local' },
                workspace: { id: 1, name: 'Panel studio' }, agents: coworkers, recentCoworkers: recent.snapshot() }
            await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
            return { container, async unmount() {
                await act(async () => { root.unmount() })
                roots.delete(root)
                container.remove()
            } }
        },
    }
}

async function openBoardChat(container: HTMLElement, name = 'Reviewer') {
    const tile = await until(() => container.querySelector<HTMLElement>(`[aria-label="Open chat with ${name}"]`))
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    return until(composer)
}

test('original coworker Open rows use existing dialogs without remounting the current board, reply or draft', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const board = mounted.container.querySelector('[aria-label="Team board"]')!
    const input = await openBoardChat(mounted.container)
    const chat = input.closest('[data-desktop-tab-active]')!
    await until(() => chat.textContent?.includes(app.answer(`${reviewer.id}-first`)))
    await enter(input, 'Reviewer keeps this draft')
    const readsBefore = [...app.messageReads]
    const targets = [
        ['Knowledge', 'Memories', 'Reviewer private memory'],
        ['Files', 'Files', 'notes.md'],
        ['Capabilities', 'Tools', 'Reviewer file access'],
        ['Skills', 'Skills', 'No skills yet'],
        ['Monitoring', 'Monitoring', 'No runs in the last 7 days'],
        ['Logs', 'Recent runs', 'Reviewer model'],
        ['Settings', 'Edit coworker', 'Reply length'],
        ['Files', 'Files', 'notes.md'],
    ]
    for (const [row, title, expected] of targets) {
        await openCoworkerPage('Reviewer')
        await chooseOpenRow(row)
        const dialog = await until(() => panelDialog(title))
        await until(() => dialog.textContent?.includes(expected))
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        expect(mounted.container.querySelector('[aria-label="Team board"]')).toBe(board)
        expect(input.isConnected).toBe(true)
        expect(input.closest('[data-desktop-tab-active]')).toBe(chat)
        expect(input.value).toBe('Reviewer keeps this draft')
        expect(chat.textContent).toContain(app.answer(`${reviewer.id}-first`))
        await dismissPanel(title)
    }
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Chat')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    expect(composer()).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Reviewer keeps this draft')
    expect(app.messageReads).toEqual(readsBefore)
    expect(app.contentWrites).toEqual([])
    expect(app.panelReads.every(path => path.includes(`/agents/${reviewer.id}/`))).toBe(true)
})

test('a contextual action launched from the board binds to the chosen coworker, including identical file names', async () => {
    const app = fixture()
    const mounted = await app.mount()
    expect(composer()).toBeNull()
    for (const agent of [auditor, reviewer]) {
        await openCoworkerPage(agent.name)
        await chooseOpenRow('Files')
        const dialog = await until(() => panelDialog('Files'))
        await until(() => dialog.textContent?.includes('notes.md'))
        expect(dialog.textContent).toContain(`${agent.name}’s workspace`)
        await click('notes.md', dialog)
        await until(() => dialog.querySelector('[data-testid="file-preview"]')?.textContent === `# ${agent.name} private file`)
        expect(dialog.textContent).not.toContain(`# ${agent.id === reviewer.id ? auditor.name : reviewer.name} private file`)
        await dismissPanel('Files')
        await openCoworkerPage(agent.name)
        await chooseOpenRow('Logs')
        const runs = await until(() => panelDialog('Recent runs'))
        await until(() => runs.textContent?.includes(`${agent.name} model`))
        expect(runs.textContent).not.toContain(`${agent.id === reviewer.id ? auditor.name : reviewer.name} model`)
        await dismissPanel('Recent runs')
        await openCoworkerPage(agent.name)
        await chooseOpenRow('Chat')
        const input = await until(composer)
        await until(() => input.closest('[data-desktop-tab-active]')?.textContent?.includes(app.answer(`${agent.id}-first`)))
        await click('Close panel', mounted.container)
    }
    expect(app.panelReads.filter(path => path.endsWith('/files/read'))).toEqual([
        `/api/desktop/agents/${auditor.id}/files/read`, `/api/desktop/agents/${reviewer.id}/files/read`,
    ])
    expect(app.contentWrites).toEqual([])
})

test('only the selected chat opens a coworker dialog and both distinct drafts restore across App remount', async () => {
    const app = fixture()
    const firstMount = await app.mount()
    const first = await openBoardChat(firstMount.container)
    await enter(first, 'First chat unsent draft')
    await click('Reviewer second chat', firstMount.container)
    const second = await until(() => { const value = composer(); return value && value !== first ? value : null })
    await until(() => second.closest('[data-desktop-tab-active]')?.textContent?.includes(app.answer(`${reviewer.id}-second`)))
    await enter(second, 'Second chat unsent draft')
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Logs')
    await until(() => panelDialog('Recent runs')?.textContent?.includes('Reviewer model'))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(app.panelReads.filter(path => path.endsWith('/runs'))).toHaveLength(1)
    expect(first.value).toBe('First chat unsent draft')
    expect(second.value).toBe('Second chat unsent draft')
    await dismissPanel('Recent runs')
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Chat')
    expect(composer()).toBe(second)
    await act(async () => { expect(await flushDesktopDrafts()).toBe(true) })
    cancelDraftShutdown()
    const before = structuredClone(app.layouts.get(reviewer.id))
    await firstMount.unmount()
    // Drop client stores so the remount must hydrate through the fixture's persisted records.
    for (const agent of coworkers) forgetCoworkerDrafts(agent.id)
    resetDesktopRecentCoworkers()
    const reopened = await app.mount()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Logs')
    await until(() => panelDialog('Recent runs')?.textContent?.includes('Reviewer model'))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    await dismissPanel('Recent runs')
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Chat')
    await until(() => composer()?.value === 'Second chat unsent draft')
    expect(app.layouts.get(reviewer.id)).toEqual(before)
    expect(composer()?.closest('[data-desktop-tab-active]')?.textContent).toContain(app.answer(`${reviewer.id}-second`))
    await click('Reviewer first chat', reopened.container)
    await until(() => composer()?.value === 'First chat unsent draft')
    expect(composer()?.closest('[data-desktop-tab-active]')?.textContent).toContain(app.answer(`${reviewer.id}-first`))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    expect(app.contentWrites).toEqual([])
})


test('restored live status must resolve before Settings opens and rejection cannot reopen it later', async () => {
    let resolveStatus!: (value: Response) => void
    const status = new Promise<Response>(resolve => { resolveStatus = resolve })
    const app = fixture(() => status)
    const mounted = await app.mount()
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Settings')
    await until(() => mounted.container.textContent?.includes('Checking this chat’s reply status'))
    expect(panelDialog('Edit coworker')).toBeUndefined()
    expect(app.panelReads.some(path => path.endsWith('/settings'))).toBe(false)
    await act(async () => { resolveStatus(Response.json({ running: true })) })
    await until(() => mounted.container.textContent?.includes('Wait for this reply to finish'))
    expect(panelDialog('Edit coworker')).toBeUndefined()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Coworker card')
    await click('Back to the chat', mounted.container)
    expect(document.activeElement).toBe(composer())
    await settle()
    expect(app.panelReads.some(path => path.endsWith('/settings'))).toBe(false)
})

test('Back cancels a pending Settings launch before the restored status arrives', async () => {
    let resolveStatus!: (value: Response) => void
    const status = new Promise<Response>(resolve => { resolveStatus = resolve })
    const app = fixture(() => status)
    const mounted = await app.mount()
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Settings')
    await until(() => mounted.container.textContent?.includes('Checking this chat’s reply status'))
    await click('Back to the chat', mounted.container)
    await act(async () => { resolveStatus(Response.json({ running: false })) })
    await settle()
    expect(panelDialog('Edit coworker')).toBeUndefined()
    expect(app.panelReads.some(path => path.endsWith('/settings'))).toBe(false)
    expect(document.activeElement).toBe(composer())
})

test('choosing Files cancels deferred Settings so its late status cannot replace the open dialog', async () => {
    let resolveStatus!: (value: Response) => void
    const status = new Promise<Response>(resolve => { resolveStatus = resolve })
    const app = fixture(() => status)
    const mounted = await app.mount()
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Settings')
    await until(() => mounted.container.textContent?.includes('Checking this chat’s reply status'))
    const edit = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit coworker')!
    expect(edit.disabled).toBe(true)
    await click('Files', mounted.container)
    const files = await until(() => panelDialog('Files'))
    await act(async () => { resolveStatus(Response.json({ running: false })) })
    await settle()
    expect(panelDialog('Files')).toBe(files)
    expect(panelDialog('Edit coworker')).toBeUndefined()
    expect(app.panelReads.some(path => path.endsWith('/settings'))).toBe(false)
})
