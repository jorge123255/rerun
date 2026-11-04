// @vitest-environment happy-dom
// Root executes these App-level preservation regressions; this fixture never reaches an engine.
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import { desktopSpaceWriteSchema, type DesktopBoardState, type DesktopSpaceWrite } from '@/lib/desktop/spaces'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { DesktopApp, type DesktopBootstrap } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep the actual App, IsoGrid, chat, menus and original NewBoxForm. Only remove animation
// drivers that happy-dom cannot finish safely while the real Radix dialog is closing.
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
const agentId = 'a1111111-1111-4111-8111-111111111111'
const firstSpaceId = 'b2222222-2222-4222-8222-222222222222'
const createdSpaceId = 'c3333333-3333-4333-8333-333333333333'
const providers = { connections: [], default: null }
// The old agent position is deliberately wrong. The independently persisted board is authoritative.
const coworker = { id: agentId, name: 'Box reviewer', description: '', enabled: true,
    createdAt: date, updatedAt: date, position: { col: 99, row: 99 } }
const originalBoard: DesktopBoardState = {
    revision: 4,
    spaces: [{ id: firstSpaceId, name: 'Main team', col_start: 0, row_start: 0, col_end: 7, row_end: 7 }],
    placements: [{ agentId, spaceId: firstSpaceId, col: 2, row: 2 }],
}
const savedReply = 'This answer belongs to the same coworker and chat.'
const draftText = 'Keep this draft while I organize the board'
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
    Reflect.deleteProperty(window, 'desktopApp')
    cancelDraftShutdown()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    expect(unexpected.splice(0)).toEqual([])
})

const composer = () => document.querySelector<HTMLTextAreaElement>('[data-desktop-tab-active="true"] #desktop-message')
const boxDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find(dialog => dialog.querySelector('[aria-label="Box name"]'))
const addBox = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Board actions"] button')]
    .find(button => button.textContent?.trim() === 'Add Box')
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function until<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 60; attempt++) {
        const value = read()
        if (value) return value
        await settle(20)
    }
    throw new Error('Expected Box integration UI did not appear')
}
async function click(label: string, scope: ParentNode = document) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    await act(async () => { button!.focus(); button!.click() })
}
async function enter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
}
async function shortcut(target: HTMLElement, key: string) {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })) })
}
async function openBox() {
    await until(() => addBox() && !addBox()!.disabled)
    await click('Add Box')
    return until(boxDialog)
}
async function closedBox() {
    await until(() => !document.querySelector('[role="dialog"]') && addBox() && !addBox()!.disabled && composer())
}

function fixture() {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const tabs = { revision: 0, activeIndex: 0, tabs: [{ uid: 'box-review-tab', id: 'box-review-chat', title: 'Saved Box review' }] }
    drafts.seedTabs(agentId, tabs.tabs)
    let board = structuredClone(originalBoard)
    const writes: DesktopSpaceWrite[] = []
    const reads: string[] = []
    const boardReads: string[] = []
    let finishCreate: (() => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const url = new URL(raw, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init)
        if (draft) return draft
        const recentResponse = recent.handle(input, init)
        if (recentResponse) return recentResponse
        if (url.pathname === '/api/desktop/spaces') {
            if (method === 'GET') { boardReads.push(url.pathname); return Response.json({ board }) }
            if (method === 'POST') {
                const write = desktopSpaceWriteSchema.parse(JSON.parse(String(init?.body)))
                expect(write.expectedRevision).toBe(board.revision)
                expect(write.command.kind).toBe('create')
                writes.push(write)
                const command = write.command
                if (command.kind !== 'create') throw new Error('Only Box creation is part of this fixture')
                return new Promise<Response>(resolve => {
                    finishCreate = () => {
                        board = { ...board, revision: board.revision + 1, spaces: [...board.spaces,
                            { id: createdSpaceId, name: command.name, col_start: 16, row_start: 0, col_end: 23, row_end: 7 }],
                        }
                        resolve(Response.json({ board }))
                    }
                })
            }
        }
        if (url.pathname === '/api/desktop/settings' && method === 'GET') return Response.json(providers)
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: { [agentId]: 'idle' } })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === `/api/desktop/agents/${agentId}/sessions` && method === 'GET') return Response.json({ sessions: [{ id: 'box-review-chat', agentId, title: 'Saved Box review', createdAt: date, updatedAt: date }], tabs })
        if (url.pathname === `/api/desktop/agents/${agentId}/tabs` && method === 'PUT') return Response.json({ tabs: { ...JSON.parse(String(init?.body)), revision: JSON.parse(String(init?.body)).baseRevision + 1 } })
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/model') && method === 'GET') return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.pathname.endsWith('/messages') && method === 'GET') { reads.push(url.pathname); return Response.json({ messages: [{ id: 'saved-box-answer', role: 'assistant', parts: [{ type: 'text', text: savedReply }] }] }) }
        if (url.pathname.endsWith('/questions') && method === 'GET') return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals') && method === 'GET') return Response.json({ approval: null })
        if (url.pathname.endsWith('/stop') && method === 'GET') return Response.json({ running: false })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    }))
    return {
        writes, reads, boardReads, savedBoard: () => structuredClone(board),
        async finish() {
            expect(finishCreate).toBeDefined()
            await act(async () => { finishCreate!() })
            finishCreate = undefined
        },
        async mount() {
            const container = document.body.appendChild(document.createElement('div'))
            const root = createRoot(container)
            roots.add(root)
            const initialData: DesktopBootstrap = { ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' },
                workspace: { id: 1, name: 'Box studio' }, agents: [coworker], board: structuredClone(board), recentCoworkers: recent.snapshot() }
            await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
            return { container, async unmount() { await act(async () => { root.unmount() }); roots.delete(root); container.remove() } }
        },
    }
}

async function openChat(container: HTMLElement, fillDraft = true) {
    const board = container.querySelector<HTMLElement>('[aria-label="Team board"]')!
    const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Box reviewer"]')!
    expect(tile).not.toBeNull()
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const input = await until(composer)
    const chat = input.closest('[data-desktop-tab-active]')!
    await until(() => chat.textContent?.includes(savedReply))
    if (fillDraft) await enter(input, draftText)
    return {
        board, tile, input, chat,
        unchanged() {
            expect(container.querySelector('[aria-label="Team board"]')).toBe(board)
            // Modal coverage removes the grid's interactive attributes, not its DOM or chat.
            expect(board.contains(tile)).toBe(true)
            expect(container.querySelector('textarea[id^="desktop-message"]')).toBe(input)
            expect(input.closest('[data-desktop-tab-active]')).toBe(chat)
            expect(input.value).toBe(draftText)
            expect(chat.textContent).toContain(savedReply)
        },
    }
}

test('New Box Cancel and awaited Save preserve the real chat, then saved board membership and draft restore from bootstrap', async () => {
    const app = fixture()
    const first = await app.mount()
    const chat = await openChat(first.container)
    const readsBefore = [...app.reads]
    expect(first.container.querySelector('[aria-label="Box Main team, 1 of 1"]')).not.toBeNull()

    const cancelled = await openBox()
    await enter(cancelled.querySelector<HTMLInputElement>('[aria-label="Box name"]')!, 'Discard this Box')
    chat.unchanged()
    await click('Cancel', cancelled)
    await closedBox()
    expect(app.writes).toEqual([])
    expect(app.savedBoard()).toEqual(originalBoard)
    chat.unchanged()

    const creating = await openBox()
    expect(creating.querySelector<HTMLInputElement>('[aria-label="Box name"]')!.value).toBe('')
    await enter(creating.querySelector<HTMLInputElement>('[aria-label="Box name"]')!, '  Studio Ops  ')
    await click('Create Studio Ops', creating)
    await until(() => app.writes.length === 1)
    expect(app.writes[0]).toMatchObject({ expectedRevision: 4, command: { kind: 'create', name: 'Studio Ops' } })
    expect(boxDialog()).toBe(creating)
    expect(creating.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    chat.unchanged()
    await app.finish()
    await closedBox()
    await until(() => first.container.querySelector('[aria-label="Box Studio Ops, 2 of 2"]'))
    expect(first.container.querySelector('[aria-label="Box Main team, 1 of 2"]')).not.toBeNull()
    expect(app.savedBoard().placements).toEqual(originalBoard.placements)
    expect(app.savedBoard().revision).toBe(5)
    expect(app.writes).toHaveLength(1)
    expect(app.reads).toEqual(readsBefore)
    chat.unchanged()
    const placedStyle = { left: chat.tile.style.left, top: chat.tile.style.top }

    await act(async () => { expect(await flushDesktopDrafts()).toBe(true) })
    await first.unmount()
    forgetCoworkerDrafts(agentId)
    cancelDraftShutdown()
    const readsBeforeRestart = app.boardReads.length
    const restored = await app.mount()
    expect(restored.container.querySelector('[aria-label="Box Main team, 1 of 2"]')).not.toBeNull()
    expect(restored.container.querySelector('[aria-label="Box Studio Ops, 2 of 2"]')).not.toBeNull()
    const reopened = await openChat(restored.container, false)
    await until(() => reopened.input.value === draftText)
    reopened.unchanged()
    expect({ left: reopened.tile.style.left, top: reopened.tile.style.top }).toEqual(placedStyle)
    expect(app.savedBoard().placements).toEqual(originalBoard.placements)
    expect(app.boardReads).toHaveLength(readsBeforeRestart)
    expect(app.writes).toHaveLength(1)
})

test('Box dialog blocks model settings, Control Center and new-chat shortcuts without replacing the chat draft', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const chat = await openChat(mounted.container)
    const readsBefore = [...app.reads]
    const openTabsBefore = document.querySelectorAll('[aria-label="Open conversations"] button[aria-pressed]').length
    const dialog = await openBox()
    const name = dialog.querySelector<HTMLInputElement>('[aria-label="Box name"]')!
    await enter(name, 'Keep naming this Box')
    for (const key of [',', 'f', 'k']) {
        await shortcut(name, key)
        expect(boxDialog()).toBe(dialog)
        expect(document.querySelector('[cmdk-input]')).toBeNull()
        expect(document.querySelector('#desktop-api-key')).toBeNull()
        expect(document.querySelector('#workspace-settings-name')).toBeNull()
        expect(name.value).toBe('Keep naming this Box')
        expect(document.querySelectorAll('[aria-label="Open conversations"] button[aria-pressed]')).toHaveLength(openTabsBefore)
        chat.unchanged()
    }
    await click('Cancel', dialog)
    await closedBox()
    expect(app.writes).toEqual([])
    expect(app.reads).toEqual(readsBefore)
    chat.unchanged()
    // The shortcut is gated only while naming the Box, not disabled for the rest of the session.
    await shortcut(document.body, 'f')
    const center = await until(() => document.querySelector<HTMLInputElement>('[cmdk-input]'))
    await shortcut(center, 'f')
    await until(() => !document.querySelector('[cmdk-input]') && composer())
    chat.unchanged()
})
