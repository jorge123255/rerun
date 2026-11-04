// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_WORKSPACE_ICONS } from '@/lib/desktop/icon-catalog'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { DesktopApp, type DesktopBootstrap } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep the actual App, menu, Radix dialog, picker, board and chat. Only replace motion's
// animation driver: happy-dom rejects its unfinished Web Animations during teardown.
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
const providers = { connections: [], default: null }
const coworker = { id: 'workspace-reviewer', name: 'Reviewer', description: '', enabled: true, createdAt: date, updatedAt: date }
const initialIcon = DESKTOP_WORKSPACE_ICONS[0]!
const pickedIcon = DESKTOP_WORKSPACE_ICONS[3]!
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
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    expect(unexpected.splice(0)).toEqual([])
})

const workspaceDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.querySelector('#workspace-settings-name'))
const pill = () => document.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu,"]')!
const composer = () => document.querySelector<HTMLTextAreaElement>('[data-desktop-tab-active="true"] #desktop-message')!
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function until<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 60; attempt++) {
        const value = read()
        if (value) return value
        await settle(20)
    }
    throw new Error('Expected workspace UI did not appear')
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
async function openWorkspaceSettings() {
    await act(async () => {
        pill().focus()
        pill().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const entry = await until(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Workspace settings'))
    await act(async () => { entry.click() })
    return until(workspaceDialog)
}
async function pickIllustration(dialog: HTMLElement) {
    const choice = [...dialog.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(button => button.querySelector('img')?.getAttribute('src') === pickedIcon.url)
    expect(choice).toBeDefined()
    await act(async () => { choice!.click() })
    expect(choice!.getAttribute('aria-pressed')).toBe('true')
}

function fixture() {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const tabs = { revision: 0, activeIndex: 0, tabs: [{ uid: 'review-tab', id: 'review-chat', title: 'Saved review' }] }
    drafts.seedTabs(coworker.id, tabs.tabs)
    let workspace = { name: 'Original studio', catalogId: initialIcon.id }
    const writes: { name: string; catalogId?: string }[] = []
    const reads: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const url = new URL(raw, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init)
        if (draft) return draft
        const recentResponse = recent.handle(input, init)
        if (recentResponse) return recentResponse
        if (url.pathname === '/api/desktop/workspace/icon') {
            if (method === 'GET') return Response.json(workspace)
            if (method === 'PUT') {
                const body = JSON.parse(String(init?.body)) as { name: string; catalogId?: string }
                writes.push(body)
                workspace = { name: body.name, catalogId: body.catalogId ?? workspace.catalogId }
                return Response.json(workspace)
            }
        }
        if (url.pathname === '/api/desktop/settings' && method === 'GET') return Response.json(providers)
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: { [coworker.id]: 'idle' } })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === `/api/desktop/agents/${coworker.id}/sessions`) return Response.json({ sessions: [{ id: 'review-chat', agentId: coworker.id, title: 'Saved review', createdAt: date, updatedAt: date }], tabs })
        if (url.pathname === `/api/desktop/agents/${coworker.id}/tabs` && method === 'PUT') return Response.json({ tabs: { ...JSON.parse(String(init?.body)), revision: JSON.parse(String(init?.body)).baseRevision + 1 } })
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.pathname.endsWith('/messages')) { reads.push(url.pathname); return Response.json({ messages: [{ id: 'saved-answer', role: 'assistant', parts: [{ type: 'text', text: 'This coworker keeps its saved answer.' }] }] }) }
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/stop') && method === 'GET') return Response.json({ running: false })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    }))
    return {
        writes, reads,
        saved: () => ({ ...workspace }),
        async mount() {
            const container = document.createElement('div')
            document.body.append(container)
            const root = createRoot(container)
            roots.add(root)
            const initialData: DesktopBootstrap = { ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' },
                workspace: { id: 1, name: workspace.name }, iconCatalogId: workspace.catalogId, agents: [coworker], recentCoworkers: recent.snapshot() }
            await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
            return { container, async unmount() { await act(async () => { root.unmount() }); roots.delete(root); container.remove() } }
        },
    }
}

test('saving workspace name and icon updates the real pill without remounting the board or chat, and saved bootstrap restores both', async () => {
    const app = fixture()
    const first = await app.mount()
    expect(pill().getAttribute('aria-label')).toBe('Workspace menu, Original studio')
    expect(pill().querySelector('img')?.getAttribute('src')).toBe(initialIcon.url)
    const board = first.container.querySelector('[aria-label="Team board"]')!
    const tile = first.container.querySelector<HTMLElement>('[aria-label="Open chat with Reviewer"]')!
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const originalComposer = await until(composer)
    const originalChat = originalComposer.closest('[data-desktop-tab-active="true"]')!
    await until(() => originalChat.textContent?.includes('This coworker keeps its saved answer.'))
    await enter(originalComposer, 'Keep this separate unsent question')
    const readsBefore = [...app.reads]

    const dialog = await openWorkspaceSettings()
    await enter(dialog.querySelector<HTMLInputElement>('#workspace-settings-name')!, '  Updated studio  ')
    await pickIllustration(dialog)
    await click('Save', dialog)
    await until(() => !workspaceDialog())
    expect(app.writes).toEqual([{ name: 'Updated studio', catalogId: pickedIcon.id }])
    expect(app.saved()).toEqual({ name: 'Updated studio', catalogId: pickedIcon.id })
    expect(pill().getAttribute('aria-label')).toBe('Workspace menu, Updated studio')
    expect(pill().querySelector('img')?.getAttribute('src')).toBe(pickedIcon.url)
    expect(first.container.querySelector('[aria-label="Team board"]')).toBe(board)
    expect(first.container.querySelector('[aria-label="Open chat with Reviewer"]')).toBe(tile)
    expect(composer()).toBe(originalComposer)
    expect(composer().closest('[data-desktop-tab-active="true"]')).toBe(originalChat)
    expect(composer().value).toBe('Keep this separate unsent question')
    expect(originalChat.textContent).toContain('This coworker keeps its saved answer.')
    expect(app.reads).toEqual(readsBefore)

    await first.unmount()
    await app.mount()
    expect(pill().getAttribute('aria-label')).toBe('Workspace menu, Updated studio')
    expect(pill().querySelector('img')?.getAttribute('src')).toBe(pickedIcon.url)
    const reopened = await openWorkspaceSettings()
    expect(reopened.querySelector<HTMLInputElement>('#workspace-settings-name')!.value).toBe('Updated studio')
    await until(() => reopened.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.querySelector('img')?.getAttribute('src') === pickedIcon.url)
    expect(app.writes).toHaveLength(1)
})

test('Cancel discards both edits and Control center or Command-comma cannot replace the open workspace dialog', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const board = mounted.container.querySelector('[aria-label="Team board"]')
    const dialog = await openWorkspaceSettings()
    const input = dialog.querySelector<HTMLInputElement>('#workspace-settings-name')!
    await enter(input, 'Discard this name')
    await pickIllustration(dialog)
    for (const key of ['f', 'k', ',']) {
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })) })
        expect(workspaceDialog()).toBe(dialog)
        expect(document.querySelector('[cmdk-input]')).toBeNull()
        expect(document.querySelector('#desktop-api-key')).toBeNull()
        expect(input.value).toBe('Discard this name')
    }
    await click('Cancel', dialog)
    // The form disappears immediately, before Radix's deferred FocusScope cleanup.
    // Wait for the real close lifecycle and restored menu focus before opening it again;
    // otherwise the old dialog's autofocus can dismiss the newly opened dropdown.
    await until(() => !document.querySelector('[role="dialog"]') && document.activeElement === pill())
    expect(app.writes).toEqual([])
    expect(app.saved()).toEqual({ name: 'Original studio', catalogId: initialIcon.id })
    expect(pill().getAttribute('aria-label')).toBe('Workspace menu, Original studio')
    expect(pill().querySelector('img')?.getAttribute('src')).toBe(initialIcon.url)
    expect(mounted.container.querySelector('[aria-label="Team board"]')).toBe(board)
    const reopened = await openWorkspaceSettings()
    expect(reopened.querySelector<HTMLInputElement>('#workspace-settings-name')!.value).toBe('Original studio')
    await until(() => reopened.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.querySelector('img')?.getAttribute('src') === initialIcon.url)
    expect(app.writes).toEqual([])
})
