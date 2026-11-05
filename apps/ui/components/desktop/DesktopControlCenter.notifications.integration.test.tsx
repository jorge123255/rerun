// @vitest-environment happy-dom
// Root executes these real-App regressions and the separate native acceptance checks.
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mergeNotificationPrefs, normalizeNotificationPrefs, type NotificationPrefsPatch } from '@rerun/contracts'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { DesktopApp, type DesktopBootstrap } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }) }))
// Keep the real board, chat, command view, dialogs and preferences. Only remove animations.
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
const reviewer = { id: 'ba75d64a-b22a-4265-a7b7-f280e20b6ef0', name: 'Reviewer', description: 'Reviews', enabled: true, createdAt: date, updatedAt: date }
const auditor = { id: '176fe87c-0243-4736-85ad-94d6ed039712', name: 'Auditor', description: 'Audits', enabled: true, createdAt: date, updatedAt: date }
const coworkers = [reviewer, auditor]
const roots = new Set<Root>()
const unexpected: string[] = []
const commandField = () => document.querySelector<HTMLInputElement>('[cmdk-input]')
const composer = () => document.querySelector<HTMLTextAreaElement>('[data-desktop-tab-active="true"] textarea[id^="desktop-message"]')
const notificationDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find(dialog => [...dialog.querySelectorAll('h1,h2,h3')].some(heading => heading.textContent === 'Notifications'))
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function until<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 80; attempt++) {
        const value = read()
        if (value) return value
        await settle(20)
    }
    throw new Error('Expected notification command UI did not appear')
}
async function enter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
}
async function click(label: string, scope: ParentNode = document) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    await act(async () => { button!.click() })
}
async function openCenter() {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })) })
    return until(commandField)
}
async function chooseNotifications(waitForPreferences = true) {
    const row = await until(() => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
        .find(item => [...item.querySelectorAll('span')].some(span => span.textContent === 'Notifications')))
    await act(async () => { row.click() })
    await until(() => !commandField())
    const dialog = await until(notificationDialog)
    if (waitForPreferences) await until(() => dialog.textContent?.includes('Per coworker'))
    return dialog
}
async function openGlobal(keyword: string, waitForPreferences = true) {
    await enter(await openCenter(), `/${keyword}`)
    return chooseNotifications(waitForPreferences)
}
async function openFor(name: string) {
    const input = await openCenter()
    await enter(input, `@${name}`)
    await until(() => document.querySelector('[cmdk-item][data-selected="true"]')?.textContent?.includes(name))
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    await until(() => commandField()?.placeholder === `Search in ${name}…`)
    return chooseNotifications()
}
async function escapeNotifications(input: HTMLTextAreaElement) {
    const dialog = await until(notificationDialog)
    await act(async () => {
        const target = dialog.querySelector<HTMLButtonElement>('button') ?? dialog
        target.focus()
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await until(() => !notificationDialog())
    await until(() => document.activeElement === input)
    expect(composer()).toBe(input)
}

beforeEach(() => {
    resetDesktopRecentCoworkers()
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
    resetDesktopRecentCoworkers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    expect(unexpected.splice(0)).toEqual([])
})

function fixture(deferWrites = false) {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const layouts = new Map<string, DesktopTabLayout>(coworkers.map(agent => [agent.id, {
        revision: 0, activeIndex: 0, tabs: [
            { uid: `${agent.id}-first-tab`, id: `${agent.id}-first`, title: `${agent.name} first chat` },
            { uid: `${agent.id}-second-tab`, id: `${agent.id}-second`, title: `${agent.name} second chat` },
        ],
    }]))
    for (const agent of coworkers) drafts.seedTabs(agent.id, layouts.get(agent.id)!.tabs)
    let prefs = normalizeNotificationPrefs(undefined)
    let preferenceReads = 0
    const pendingWrites: Array<(response: Response) => void> = []
    const writes: NotificationPrefsPatch[] = []
    const messageReads: string[] = []
    const answer = (id: string) => `Saved answer belonging to ${id}.`
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const url = new URL(raw, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init)
        if (draft) return draft
        const recentResponse = recent.handle(input, init)
        if (recentResponse) return recentResponse
        if (url.pathname === '/api/desktop/notifications') {
            if (method === 'GET') { preferenceReads++; return Response.json(prefs) }
            if (method === 'PUT') {
                const patch = JSON.parse(String(init?.body)) as NotificationPrefsPatch
                writes.push(patch)
                prefs = mergeNotificationPrefs(prefs, patch)
                if (deferWrites) return new Promise<Response>(resolve => { pendingWrites.push(resolve) })
                return Response.json(prefs)
            }
        }
        if (url.pathname === '/api/desktop/agents' && method === 'GET') return Response.json({ agents: coworkers })
        if (url.pathname === '/api/desktop/settings' && method === 'GET') return Response.json(providers)
        if (url.pathname === '/api/desktop/workspace/icon' && method === 'GET') return Response.json({ catalogId: null })
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: Object.fromEntries(coworkers.map(agent => [agent.id, 'idle'])) })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === '/api/desktop/conversations/search') return Response.json({ hits: [], hasMore: false })
        const route = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/(sessions|tabs|control-center-chats)$/)
        if (route) {
            const id = decodeURIComponent(route[1]), layout = layouts.get(id)
            if (!layout) throw new Error(`Unknown fixture coworker ${id}`)
            if (route[2] === 'sessions') return Response.json({ sessions: layout.tabs.map(tab => ({ id: tab.id!, agentId: id, title: tab.title, createdAt: date, updatedAt: date })), tabs: layout })
            if (route[2] === 'tabs' && method === 'PUT') {
                const body = JSON.parse(String(init?.body))
                const titles = new Map(layout.tabs.map(tab => [tab.uid, tab.title]))
                const next: DesktopTabLayout = { revision: body.baseRevision + 1, activeIndex: body.activeIndex,
                    tabs: body.tabs.map((tab: { uid: string; id: string | null }) => ({ ...tab, title: titles.get(tab.uid) ?? 'New conversation' })) }
                layouts.set(id, next)
                return Response.json({ tabs: next })
            }
            if (route[2] === 'control-center-chats') return Response.json({ agentId: id, openChats: layout.tabs.map(tab => ({ agentId: id, tabUid: tab.uid, sessionId: tab.id, title: tab.title })), recentChats: [], recentStatus: 'ok', hasMore: false })
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
        if (url.pathname.endsWith('/stop') && method === 'GET') return Response.json({ running: false })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        const background = desktopBackgroundRead(input, init); if (background) return background
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    }))
    return { writes, messageReads, layouts, answer, preferences: () => structuredClone(prefs), preferenceReads: () => preferenceReads,
        async finishWrites() { await act(async () => { for (const finish of pendingWrites.splice(0)) finish(Response.json(prefs)) }) }, async mount() {
        const container = document.createElement('div')
        document.body.append(container)
        const root = createRoot(container)
        roots.add(root)
        const initialData: DesktopBootstrap = { ...providers, theme: 'dark', profile: { id: 1, displayName: 'Local' },
            workspace: { id: 1, name: 'Notifications studio' }, agents: coworkers, recentCoworkers: recent.snapshot() }
        await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
        return { container, async unmount() { await act(async () => { root.unmount() }); roots.delete(root); container.remove() } }
    } }
}
async function openReviewer(container: HTMLElement) {
    const tile = await until(() => container.querySelector<HTMLElement>('[aria-label="Open chat with Reviewer"]'))
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    return until(() => { const input = composer(); return input && !input.disabled ? input : null })
}

test('global notification commands preserve the real board, selected chat, reply and draft, and Escape returns focus', async () => {
    const app = fixture(), mounted = await app.mount()
    const board = mounted.container.querySelector('[aria-label="Team board"]')
    const input = await openReviewer(mounted.container)
    const chat = input.closest('[data-desktop-tab-active]')!
    await until(() => chat.textContent?.includes(app.answer(`${reviewer.id}-first`)))
    await enter(input, 'Keep this notification review draft')
    await act(async () => { input.focus() })
    const before = [...app.messageReads]
    for (const keyword of ['alerts', 'push', 'sound']) {
        const dialog = await openGlobal(keyword)
        expect(dialog.textContent).toContain('Every coworker follows the rule above.')
        expect(dialog.querySelector('[aria-label="Notifications for Reviewer"]')).toBeNull()
        expect(dialog.querySelector('[aria-label="Notifications for Auditor"]')).toBeNull()
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        expect(mounted.container.querySelector('[aria-label="Team board"]')).toBe(board)
        expect(input.isConnected).toBe(true)
        expect(input.closest('[data-desktop-tab-active]')).toBe(chat)
        expect(input.value).toBe('Keep this notification review draft')
        expect(chat.textContent).toContain(app.answer(`${reviewer.id}-first`))
        expect(app.writes).toEqual([])
        await escapeNotifications(input)
    }
    expect(app.messageReads).toEqual(before)
})

test('a different coworker is pinned without a write, changes only its rule, and the original selected tab and drafts restore', async () => {
    const app = fixture(), mounted = await app.mount()
    const first = await openReviewer(mounted.container)
    await enter(first, 'First chat draft')
    await click('Reviewer second chat', mounted.container)
    const second = await until(() => { const input = composer(); return input && input !== first ? input : null })
    await until(() => second.closest('[data-desktop-tab-active]')?.textContent?.includes(app.answer(`${reviewer.id}-second`)))
    await enter(second, 'Second chat draft')
    await act(async () => { second.focus() })
    const initialPrefs = app.preferences()
    const dialog = await openFor('Auditor')
    const auditorRule = await until(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Notifications for Auditor"]'))
    expect(auditorRule.textContent).toContain('Default')
    expect(dialog.querySelector('[aria-label="Notifications for Reviewer"]')).toBeNull()
    expect(app.writes).toEqual([])
    expect(second.isConnected).toBe(true)
    expect(second.closest('[data-desktop-tab-active]')?.textContent).toContain(app.answer(`${reviewer.id}-second`))
    await act(async () => { auditorRule.click() })
    const muted = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.getAttribute('data-state') !== 'checked' && option.textContent?.trim() === 'Muted'))
    await act(async () => { muted.click() })
    await until(() => app.writes.length === 1)
    expect(app.writes).toEqual([{ coworkers: { [auditor.id]: { mode: 'muted' } } }])
    expect(app.preferences()).toEqual(mergeNotificationPrefs(initialPrefs, app.writes[0]!))
    expect(app.preferences().coworkers[reviewer.id]).toBeUndefined()
    await escapeNotifications(second)
    const reviewerDialog = await openFor('Reviewer')
    expect(reviewerDialog.querySelector('[aria-label="Notifications for Reviewer"]')).not.toBeNull()
    expect(reviewerDialog.querySelector('[aria-label="Notifications for Auditor"]')?.textContent).toContain('Muted')
    expect(app.writes).toHaveLength(1)
    await escapeNotifications(second)
    const global = await openGlobal('alerts')
    expect(global.querySelector('[aria-label="Notifications for Reviewer"]')).toBeNull()
    expect(global.querySelector('[aria-label="Notifications for Auditor"]')?.textContent).toContain('Muted')
    await escapeNotifications(second)
    expect(first.value).toBe('First chat draft')
    expect(second.value).toBe('Second chat draft')
    await act(async () => { expect(await flushDesktopDrafts()).toBe(true) })
    cancelDraftShutdown()
    const beforeTabs = structuredClone(app.layouts.get(reviewer.id))
    await mounted.unmount()
    for (const agent of coworkers) forgetCoworkerDrafts(agent.id)
    resetDesktopRecentCoworkers()
    const reopened = await app.mount()
    const restored = await openReviewer(reopened.container)
    await until(() => restored.value === 'Second chat draft')
    expect(app.layouts.get(reviewer.id)).toEqual(beforeTabs)
    const reopenedDialog = await openGlobal('push')
    expect(reopenedDialog.querySelector('[aria-label="Notifications for Auditor"]')?.textContent).toContain('Muted')
    expect(reopenedDialog.querySelector('[aria-label="Notifications for Reviewer"]')).toBeNull()
    expect(app.writes).toHaveLength(1)
    await escapeNotifications(restored)
    await click('Reviewer first chat', reopened.container)
    await until(() => composer()?.value === 'First chat draft')
})

test('closing and reopening while a preference save is pending waits for its receipt before reading authoritative settings', async () => {
    const app = fixture(true), mounted = await app.mount()
    const input = await openReviewer(mounted.container)
    await enter(input, 'Draft survives an admitted preference save')
    await act(async () => { input.focus() })
    const dialog = await openGlobal('alerts')
    try {
        const everything = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
            .find(radio => radio.textContent?.includes('Everything'))
        expect(everything).toBeDefined()
        await act(async () => { everything!.click() })
        await until(() => app.writes.length === 1)
        expect(app.writes).toEqual([{ scope: 'everything' }])
        const readsBefore = app.preferenceReads()
        await escapeNotifications(input)
        const reopened = await openGlobal('push', false)
        await settle()
        expect(reopened).not.toBe(dialog)
        expect(reopened.textContent).toContain('Loading your notification settings')
        expect(app.preferenceReads()).toBe(readsBefore)
        await app.finishWrites()
        await until(() => reopened.textContent?.includes('Per coworker'))
        expect(app.preferenceReads()).toBe(readsBefore + 1)
        const selected = [...reopened.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
            .find(radio => radio.getAttribute('aria-checked') === 'true')
        expect(selected?.textContent).toContain('Everything')
        expect(app.writes).toHaveLength(1)
        await escapeNotifications(input)
        expect(input.value).toBe('Draft survives an admitted preference save')
    } finally { await app.finishWrites() }
})
