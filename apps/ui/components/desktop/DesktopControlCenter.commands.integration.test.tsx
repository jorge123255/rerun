// @vitest-environment happy-dom
// Root-owned acceptance regressions. Helpers author; the integration owner executes them.
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ThemePreference } from '@rerun/ui/theme'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { DesktopApp, type DesktopBootstrap } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appearance = vi.hoisted(() => ({
    theme: 'system' as ThemePreference,
    resolvedTheme: 'dark',
    systemTheme: 'dark',
    listeners: new Set<() => void>(),
    setTheme: vi.fn(),
    toastError: vi.fn(),
    toastDismiss: vi.fn(),
}))
vi.mock('next-themes', async () => {
    const { useSyncExternalStore } = await import('react')
    return { useTheme: () => {
        useSyncExternalStore(listener => {
            appearance.listeners.add(listener)
            return () => { appearance.listeners.delete(listener) }
        }, () => `${appearance.theme}:${appearance.resolvedTheme}`, () => 'system:dark')
        return { theme: appearance.theme, resolvedTheme: appearance.resolvedTheme, systemTheme: appearance.systemTheme, setTheme: appearance.setTheme }
    } }
})
vi.mock('sonner', async original => {
    const actual = await original<typeof import('sonner')>()
    return { ...actual, toast: Object.assign(vi.fn(), { error: appearance.toastError, dismiss: appearance.toastDismiss }) }
})

// Keep App, board, chat, menus, Radix and the original command view. Only replace motion's
// animation driver, which happy-dom cannot finish safely when a dialog closes.
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
const coworker = { id: 'command-reviewer', name: 'Reviewer', description: '', enabled: true, createdAt: date, updatedAt: date }
const roots = new Set<ReturnType<typeof createRoot>>()
const unexpected: string[] = []

beforeEach(() => {
    appearance.theme = 'system'
    appearance.resolvedTheme = appearance.systemTheme = 'dark'
    appearance.setTheme.mockReset().mockImplementation((next: ThemePreference) => {
        appearance.theme = next
        appearance.resolvedTheme = next === 'system' ? appearance.systemTheme : next
        for (const listener of appearance.listeners) listener()
    })
    appearance.toastError.mockReset().mockReturnValue('appearance-error')
    appearance.toastDismiss.mockReset()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
})
afterEach(async () => {
    await act(async () => { for (const root of roots) root.unmount() })
    roots.clear()
    document.body.innerHTML = ''
    appearance.listeners.clear()
    Reflect.deleteProperty(window, 'desktopApp')
    cancelDraftShutdown()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    expect(unexpected.splice(0)).toEqual([])
})

const composer = () => document.querySelector<HTMLTextAreaElement>('[data-desktop-tab-active="true"] #desktop-message')!
const commandField = () => document.querySelector<HTMLInputElement>('[cmdk-input]')
const workspaceDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.querySelector('#workspace-settings-name'))
const shortcutsDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.querySelector('h2')?.textContent === 'Keyboard shortcuts')
const workspacePill = () => document.querySelector<HTMLButtonElement>('[aria-label="Workspace menu, Command studio"]')!
const openTabButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Open conversations"] button[aria-pressed]')]
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function until<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 60; attempt++) {
        const value = read()
        if (value) return value
        await settle(20)
    }
    throw new Error('Expected command UI did not appear')
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
const shortcut = () => act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })) })
async function openCommands() {
    await shortcut()
    const field = await until(commandField)
    await enter(field, '/')
    return field
}
async function runCommand(label: string) {
    const row = await until(() => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(item => item.textContent?.trim() === label))
    await act(async () => { row.click() })
}

async function openShortcutsFromMenu() {
    await act(async () => {
        workspacePill().focus()
        workspacePill().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const entry = await until(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Keyboard shortcuts'))
    await act(async () => { entry.click() })
    return until(shortcutsDialog)
}

async function closeShortcutsWithEscape(dialog: HTMLElement) {
    await act(async () => {
        const target = dialog.querySelector<HTMLButtonElement>('button') ?? dialog
        target.focus()
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await until(() => !shortcutsDialog())
    await until(() => document.activeElement === workspacePill())
}

function fixture(initialTheme: ThemePreference = 'system') {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const tabs = { revision: 0, activeIndex: 0, tabs: [{ uid: 'command-tab', id: 'command-chat', title: 'Saved review' }] }
    drafts.seedTabs(coworker.id, tabs.tabs)
    let savedTheme = initialTheme
    const writes: { body: { action: 'appearance'; theme: ThemePreference }; finish: (response: Response) => void }[] = []
    const reads: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const url = new URL(raw, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init)
        if (draft) return draft
        const recentResponse = recent.handle(input, init)
        if (recentResponse) return recentResponse
        if (url.pathname === '/api/desktop/settings') {
            if (method === 'GET') return Response.json(providers)
            if (method === 'PATCH') {
                const body = JSON.parse(String(init?.body)) as { action: 'appearance'; theme: ThemePreference }
                let finish!: (response: Response) => void
                const response = new Promise<Response>(resolve => { finish = resolve })
                writes.push({ body, finish })
                const result = await response
                if (result.ok) savedTheme = body.theme
                return result
            }
        }
        if (url.pathname === '/api/desktop/workspace/icon' && method === 'GET') return Response.json({ catalogId: null })
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: { [coworker.id]: 'idle' } })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === `/api/desktop/agents/${coworker.id}/sessions`) return Response.json({ sessions: [{ id: 'command-chat', agentId: coworker.id, title: 'Saved review', createdAt: date, updatedAt: date }], tabs })
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
        writes, reads, savedTheme: () => savedTheme,
        async mount() {
            const container = document.createElement('div')
            document.body.append(container)
            const root = createRoot(container)
            roots.add(root)
            const initialData: DesktopBootstrap = { ...providers, theme: savedTheme, profile: { id: 1, displayName: 'Local' },
                workspace: { id: 1, name: 'Command studio' }, agents: [coworker], recentCoworkers: recent.snapshot() }
            await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
            return { container, async unmount() { await act(async () => { root.unmount() }); roots.delete(root); container.remove() } }
        },
        async finish(index: number, ok = true) {
            expect(writes[index]).toBeDefined()
            await act(async () => { writes[index].finish(ok ? Response.json(providers) : Response.json({ error: 'Synthetic theme save failure' }, { status: 500 })) })
        },
    }
}

async function openChat(container: HTMLElement) {
    const board = container.querySelector<HTMLElement>('[aria-label="Team board"]')!
    const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Reviewer"]')!
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const input = await until(composer)
    const chat = input.closest('[data-desktop-tab-active="true"]')!
    await until(() => chat.textContent?.includes('This coworker keeps its saved answer.'))
    await enter(input, 'Keep this command draft')
    return {
        board, tile, input, chat,
        unchanged(covered = false) {
            expect(container.querySelector('[aria-label="Team board"]')).toBe(board)
            expect(container.querySelector('[aria-label="Open chat with Reviewer"]')).toBe(tile)
            expect(covered ? container.querySelector('textarea[id^="desktop-message"]') : composer()).toBe(input)
            expect(input.closest('[data-desktop-tab-active]')).toBe(chat)
            expect(input.value).toBe('Keep this command draft')
            expect(chat.textContent).toContain('This coworker keeps its saved answer.')
        },
    }
}

test('the real workspace command opens the existing picker while retaining the board, chat and draft', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const view = await openChat(mounted.container)
    const readsBefore = [...app.reads]
    await openCommands()
    await runCommand('Workspace settings')
    const dialog = await until(workspaceDialog)
    expect(commandField()).toBeNull()
    expect(dialog.querySelector<HTMLInputElement>('#workspace-settings-name')!.value).toBe('Command studio')
    expect(dialog.textContent).toContain('Or pick an illustration')
    expect(document.querySelector('#desktop-api-key')).toBeNull()
    view.unchanged(true)
    await click('Cancel', dialog)
    await until(() => !workspaceDialog() && !document.querySelector('[role="dialog"]'))
    view.unchanged()
    expect(app.reads).toEqual(readsBefore)
    expect(app.writes).toEqual([])
})

test('Quit waits for the admitted theme save and applies its durable result before finishing', async () => {
    let beforeQuit!: () => Promise<boolean>
    Object.defineProperty(window, 'desktopApp', { configurable: true, value: {
        onBeforeQuit: (listener: () => Promise<boolean>) => { beforeQuit = listener; return () => {} },
    } })
    const app = fixture()
    await app.mount()
    await openCommands()
    await runCommand('Switch to light theme')
    let finished = false
    let ready!: Promise<boolean>
    await act(async () => { ready = beforeQuit().then(result => { finished = true; return result }) })
    await settle(20)
    expect(finished).toBe(false)
    expect(app.savedTheme()).toBe('system')
    await app.finish(0)
    await act(async () => { expect(await ready).toBe(true) })
    expect(finished).toBe(true)
    expect(app.savedTheme()).toBe('light')
    expect(appearance.theme).toBe('light')
})

test('theme follows resolved system appearance, waits for the durable save, and restores the saved choice on remount', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const view = await openChat(mounted.container)
    await openCommands()
    await runCommand('Switch to light theme')
    expect(app.writes.map(write => write.body)).toEqual([{ action: 'appearance', theme: 'light' }])
    expect(appearance.setTheme).not.toHaveBeenCalled()
    expect(app.savedTheme()).toBe('system')
    await shortcut()
    expect(commandField()).toBeNull()
    expect(app.writes).toHaveLength(1)
    view.unchanged()
    await app.finish(0)
    await until(() => appearance.theme === 'light')
    expect(appearance.setTheme).toHaveBeenCalledExactlyOnceWith('light')
    expect(app.savedTheme()).toBe('light')
    view.unchanged()
    await mounted.unmount()
    await app.mount()
    await openCommands()
    expect([...document.querySelectorAll('[cmdk-item]')].some(row => row.textContent?.trim() === 'Switch to dark theme')).toBe(true)
    expect(app.writes).toHaveLength(1)
    expect(appearance.toastError).not.toHaveBeenCalled()
})

test('failed theme persistence leaves the original appearance and draft intact and retries the same target only once', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const view = await openChat(mounted.container)
    const readsBefore = [...app.reads]
    await openCommands()
    await runCommand('Switch to light theme')
    await app.finish(0, false)
    await until(() => appearance.toastError.mock.calls.length === 1)
    expect(appearance.toastError.mock.calls[0][0]).toBe('Could not save theme.')
    const notification = appearance.toastError.mock.calls[0][1] as { description: string; action: { label: string; onClick: () => void } }
    expect(notification.description).toContain('Synthetic theme save failure')
    expect(notification.action.label).toBe('Retry')
    expect(appearance.setTheme).not.toHaveBeenCalled()
    expect(appearance.theme).toBe('system')
    expect(app.savedTheme()).toBe('system')
    view.unchanged()
    await act(async () => { notification.action.onClick(); notification.action.onClick() })
    expect(app.writes.map(write => write.body)).toEqual([
        { action: 'appearance', theme: 'light' }, { action: 'appearance', theme: 'light' },
    ])
    expect(appearance.toastDismiss).toHaveBeenCalled()
    expect(appearance.setTheme).not.toHaveBeenCalled()
    await app.finish(1)
    await until(() => appearance.theme === 'light')
    expect(appearance.setTheme).toHaveBeenCalledExactlyOnceWith('light')
    expect(app.savedTheme()).toBe('light')
    expect(app.reads).toEqual(readsBefore)
    view.unchanged()
})

test('Recenter the board applies the existing canvas framing without replacing the open chat or its draft', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const view = await openChat(mounted.container)
    const world = await until(() => [...view.board.querySelectorAll<HTMLElement>('[style]')].find(node => node.style.transform.startsWith('scale(') && node.style.transform.includes('translate(')))
    // Establish the native canvas button's framing as the expected target, avoiding assumptions
    // about viewport geometry in happy-dom. The command must reach that same camera again.
    await click('Recenter view')
    const centered = world.style.transform
    await click('Zoom in')
    await until(() => world.style.transform !== centered)
    const readsBefore = [...app.reads]
    await openCommands()
    await runCommand('Recenter the board')
    await until(() => world.style.transform === centered)
    expect(commandField()).toBeNull()
    expect(world.isConnected).toBe(true)
    view.unchanged()
    expect(app.reads).toEqual(readsBefore)
    expect(app.writes).toEqual([])
})

test('the /hotkeys command opens the original help view with only the six supported Mac shortcuts', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const view = await openChat(mounted.container)
    const readsBefore = [...app.reads]
    const field = await openCommands()
    await enter(field, '/hotkeys')
    const matches = await until(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
        return rows.some(row => row.textContent?.trim() === 'Keyboard shortcuts') ? rows : null
    })
    expect(matches.map(row => row.textContent?.trim())).toEqual(['Keyboard shortcuts'])
    await runCommand('Keyboard shortcuts')
    const dialog = await until(shortcutsDialog)
    expect(commandField()).toBeNull()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(dialog.textContent).toContain('Move faster around Rerun with these shortcuts.')
    const shortcutRows = [...new Set([...dialog.querySelectorAll('kbd')].map(key => key.parentElement!.parentElement!))]
    expect(shortcutRows.map(row => ({ action: row.firstElementChild?.textContent, keys: [...row.querySelectorAll('kbd')].map(key => key.textContent) }))).toEqual([
        { action: 'Open the control center', keys: ['⌘', 'F'] },
        { action: 'Open the control center, outside a chat or text field', keys: ['⌘', 'K'] },
        { action: 'New conversation', keys: ['⌘', 'K'] },
        { action: 'Close active tab, outside a text field', keys: ['⌘', '⌫'] },
        { action: 'Send message', keys: ['Enter'] },
        { action: 'New line', keys: ['Shift', 'Enter'] },
    ])
    expect(dialog.textContent).toContain('Previous file')
    expect(dialog.textContent).toContain('Next file')
    expect(dialog.textContent).not.toMatch(/Ask Rerun|Hold to talk|Search in the page|×2/)
    view.unchanged(true)
    await closeShortcutsWithEscape(dialog)
    expect(commandField()).toBeNull()
    view.unchanged()
    expect(openTabButtons()).toHaveLength(1)
    expect(app.reads).toEqual(readsBefore)
    expect(app.writes).toEqual([])
})

test('workspace help blocks chat and settings shortcuts until Escape closes only the help', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const view = await openChat(mounted.container)
    const readsBefore = [...app.reads]
    const dialog = await openShortcutsFromMenu()
    await until(() => !document.querySelector('[role="menu"]'))
    expect(openTabButtons()).toHaveLength(1)
    for (const key of ['k', 'f', ',']) {
        await act(async () => {
            const target = dialog.querySelector<HTMLButtonElement>('button') ?? dialog
            target.focus()
            target.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }))
        })
        await settle()
        expect(shortcutsDialog()).toBe(dialog)
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        expect(commandField()).toBeNull()
        expect(document.querySelector('#desktop-api-key')).toBeNull()
        expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Back to chat')).toBe(false)
        expect(openTabButtons()).toHaveLength(1)
        view.unchanged(true)
    }
    await closeShortcutsWithEscape(dialog)
    view.unchanged()
    expect(app.reads).toEqual(readsBefore)
    await act(async () => {
        view.input.focus()
        view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))
    })
    await until(() => openTabButtons().length === 2)
    expect(commandField()).toBeNull()
    expect(shortcutsDialog()).toBeUndefined()
    expect(composer()).not.toBe(view.input)
    expect(composer().value).toBe('')
    expect(view.input.value).toBe('Keep this command draft')
    expect(view.chat.textContent).toContain('This coworker keeps its saved answer.')
    await click('Saved review')
    await until(() => composer() === view.input)
    view.unchanged()
    expect(app.writes).toEqual([])
})

test('help is transient on remount and reopens from the workspace menu beside the restored chat draft', async () => {
    const app = fixture()
    const first = await app.mount()
    const view = await openChat(first.container)
    await until(() => view.chat.textContent?.includes('Draft saved'))
    await openShortcutsFromMenu()
    view.unchanged(true)
    await first.unmount()
    const second = await app.mount()
    expect(shortcutsDialog()).toBeUndefined()
    expect(commandField()).toBeNull()
    const tile = second.container.querySelector<HTMLElement>('[aria-label="Open chat with Reviewer"]')!
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const restored = await until(() => composer()?.value === 'Keep this command draft' ? composer() : null)
    const chat = restored.closest('[data-desktop-tab-active]')!
    await until(() => chat.textContent?.includes('This coworker keeps its saved answer.'))
    const dialog = await openShortcutsFromMenu()
    expect(second.container.querySelector('textarea[id^="desktop-message"]')).toBe(restored)
    expect(restored.value).toBe('Keep this command draft')
    await closeShortcutsWithEscape(dialog)
    expect(composer()).toBe(restored)
    expect(document.activeElement).toBe(workspacePill())
    expect(openTabButtons()).toHaveLength(1)
    expect(chat.textContent).toContain('This coworker keeps its saved answer.')
    expect(app.writes).toEqual([])
})
