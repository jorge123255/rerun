// @vitest-environment happy-dom
// Root executes these real-App regressions. All requests stay inside the synthetic fixture.
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import { desktopSpaceWriteSchema, type DesktopBoardState, type DesktopSpaceWrite } from '@/lib/desktop/spaces'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { DesktopApp, type DesktopBootstrap } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep App, IsoGrid, chat, the original command view and the actual NewBoxForm. Only remove
// animation drivers that happy-dom cannot finish safely while Radix dialogs close.
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
const reviewerId = 'a1111111-1111-4111-8111-111111111111'
const analystId = 'd4444444-4444-4444-8444-444444444444'
const mainId = 'b2222222-2222-4222-8222-222222222222'
const projectId = 'e5555555-5555-4555-8555-555555555555'
const newBoxId = 'c3333333-3333-4333-8333-333333333333'
const providers = { connections: [], default: null }
const coworkers = [
    { id: reviewerId, name: 'Box reviewer', description: '', enabled: true, createdAt: date, updatedAt: date },
    { id: analystId, name: 'Project analyst', description: '', enabled: true, createdAt: date, updatedAt: date },
]
const initialBoard: DesktopBoardState = {
    revision: 7,
    spaces: [
        { id: mainId, name: 'Main team', col_start: 0, row_start: 0, col_end: 7, row_end: 7 },
        { id: projectId, name: 'Project team', col_start: 12, row_start: 0, col_end: 19, row_end: 7 },
    ],
    placements: [
        { agentId: reviewerId, spaceId: mainId, col: 2, row: 2 },
        { agentId: analystId, spaceId: projectId, col: 14, row: 2 },
    ],
}
const replyOf = (agentId: string) => agentId === reviewerId ? 'The reviewer keeps this saved answer.' : 'The analyst has a separate saved answer.'
const draftText = 'Keep the reviewer draft while organizing Boxes'
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
const commandField = () => document.querySelector<HTMLInputElement>('[cmdk-input]')
const boxDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.querySelector('[aria-label="Box name"]'))
const row = (id: string) => document.querySelector<HTMLElement>(`[cmdk-item][data-value="${id}"]`)
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function until<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 60; attempt++) {
        const value = read()
        if (value) return value
        await settle(20)
    }
    throw new Error('Expected Control Center Box UI did not appear')
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
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    await act(async () => { button!.click() })
}
async function choose(id: string) {
    const item = await until(() => row(id))
    await act(async () => { item.click() })
}
async function openCommands(query: string) {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })) })
    const input = await until(commandField)
    await enter(input, query)
    return input
}
async function openNewBox() {
    await openCommands('/New Box')
    await choose('command-new_box')
    const dialog = await until(boxDialog)
    expect(commandField()).toBeNull()
    return dialog
}
async function moveReviewerTo(spaceId: string) {
    const input = await openCommands('@Box reviewer')
    await until(() => row(`coworkers-coworker-${reviewerId}`))
    await act(async () => {
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    await choose('coworker-move')
    await choose(`move-${spaceId}`)
    await until(() => !commandField())
}

function fixture() {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const tabsOf = (agentId: string) => ({ revision: 0, activeIndex: 0,
        tabs: [{ uid: `tab-${agentId}`, id: `chat-${agentId}`, title: `Saved ${agentId === reviewerId ? 'review' : 'analysis'}` }] })
    for (const coworker of coworkers) drafts.seedTabs(coworker.id, tabsOf(coworker.id).tabs)
    let board = structuredClone(initialBoard)
    const writes: DesktopSpaceWrite[] = []
    const responses: ((response: Response) => void)[] = []
    const applied = new Map<string, DesktopSpaceWrite>()
    const reads: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const url = new URL(raw, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init)
        if (draft) return draft
        const recentResponse = recent.handle(input, init)
        if (recentResponse) return recentResponse
        if (url.pathname === '/api/desktop/spaces') {
            if (method === 'GET') return Response.json({ board })
            if (method === 'POST') {
                writes.push(desktopSpaceWriteSchema.parse(JSON.parse(String(init?.body))))
                return new Promise<Response>(resolve => { responses.push(resolve) })
            }
        }
        if (url.pathname === '/api/desktop/settings' && method === 'GET') return Response.json(providers)
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: { [reviewerId]: 'idle', [analystId]: 'idle' } })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === '/api/desktop/conversations/search') return Response.json({ hits: [], hasMore: false })
        const owner = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\//)?.[1]
        if (owner && coworkers.some(coworker => coworker.id === owner)) {
            const tabs = tabsOf(owner)
            if (url.pathname.endsWith('/sessions') && method === 'GET') return Response.json({ sessions: [{ id: `chat-${owner}`, agentId: owner, title: tabs.tabs[0].title, createdAt: date, updatedAt: date }], tabs })
            if (url.pathname.endsWith('/control-center-chats') && method === 'GET') return Response.json({ agentId: owner, openChats: [], recentChats: [], recentStatus: 'ok', hasMore: false })
            if (url.pathname.endsWith('/tabs') && method === 'PUT') { const body = JSON.parse(String(init?.body)); return Response.json({ tabs: { ...body, revision: body.baseRevision + 1 } }) }
        }
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/model') && method === 'GET') return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.pathname.endsWith('/messages') && method === 'GET') {
            const chatOwner = coworkers.find(coworker => url.pathname.includes(`chat-${coworker.id}`))
            if (chatOwner) { reads.push(url.pathname); return Response.json({ messages: [{ id: `answer-${chatOwner.id}`, role: 'assistant', parts: [{ type: 'text', text: replyOf(chatOwner.id) }] }] }) }
        }
        if (url.pathname.endsWith('/questions') && method === 'GET') return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals') && method === 'GET') return Response.json({ approval: null })
        if (url.pathname.endsWith('/stop') && method === 'GET') return Response.json({ running: false })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    }))
    return {
        writes, reads, savedBoard: () => structuredClone(board),
        async finish(index: number, loseResponse = false) {
            const write = writes[index]
            expect(write).toBeDefined()
            const previous = applied.get(write.requestId)
            if (previous) expect(write).toEqual(previous)
            else {
                expect(write.expectedRevision).toBe(board.revision)
                const command = write.command
                if (command.kind === 'create') board = { ...board, revision: board.revision + 1, spaces: [...board.spaces,
                    { id: newBoxId, name: command.name, col_start: 24, row_start: 0, col_end: 31, row_end: 7 }] }
                else if (command.kind === 'move-agent') board = { ...board, revision: board.revision + 1,
                    placements: board.placements.map(placed => placed.agentId === command.agentId
                        ? { ...placed, spaceId: command.spaceId, col: command.spaceId === mainId ? 0 : 12, row: 0 } : placed) }
                else throw new Error('This fixture only creates Boxes and moves coworkers')
                applied.set(write.requestId, structuredClone(write))
            }
            await act(async () => { responses[index](loseResponse
                ? Response.json({ error: 'Could not confirm this Box move. Retry to check it.' }, { status: 500 })
                : Response.json({ board })) })
        },
        async mount() {
            const container = document.body.appendChild(document.createElement('div'))
            const root = createRoot(container)
            roots.add(root)
            const initialData: DesktopBootstrap = { ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' },
                workspace: { id: 1, name: 'Command Box studio' }, agents: coworkers, board: structuredClone(board), recentCoworkers: recent.snapshot() }
            await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
            return container
        },
    }
}

async function openReviewer(container: HTMLElement) {
    const board = container.querySelector<HTMLElement>('[aria-label="Team board"]')!
    const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Box reviewer"]')!
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    const input = await until(composer)
    const chat = input.closest('[data-desktop-tab-active]')!
    await until(() => chat.textContent?.includes(replyOf(reviewerId)))
    await enter(input, draftText)
    return { board, tile, input, chat, unchanged() {
        expect(container.querySelector('[aria-label="Team board"]')).toBe(board)
        expect(board.contains(tile)).toBe(true)
        expect(container.querySelector('textarea[id^="desktop-message"]')).toBe(input)
        expect(input.closest('[data-desktop-tab-active]')).toBe(chat)
        expect(input.value).toBe(draftText)
        expect(chat.textContent).toContain(replyOf(reviewerId))
        expect(chat.textContent).not.toContain(replyOf(analystId))
    } }
}

test('Control Center New Box opens the real form once; Cancel and awaited Save preserve the board, chat and draft', async () => {
    const app = fixture()
    const container = await app.mount()
    const chat = await openReviewer(container)
    const readsBefore = [...app.reads]
    const cancelled = await openNewBox()
    await enter(cancelled.querySelector<HTMLInputElement>('[aria-label="Box name"]')!, 'Discarded Box')
    chat.unchanged()
    await click('Cancel', cancelled)
    await until(() => !boxDialog() && composer())
    await settle(30)
    expect(boxDialog()).toBeUndefined()
    expect(app.writes).toEqual([])
    chat.unchanged()

    const creating = await openNewBox()
    expect(creating.querySelector<HTMLInputElement>('[aria-label="Box name"]')!.value).toBe('')
    await enter(creating.querySelector<HTMLInputElement>('[aria-label="Box name"]')!, '  Studio Ops  ')
    await click('Create Studio Ops', creating)
    await until(() => app.writes.length === 1)
    expect(app.writes[0]).toMatchObject({ expectedRevision: 7, command: { kind: 'create', name: 'Studio Ops' } })
    expect(boxDialog()).toBe(creating)
    expect(creating.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    chat.unchanged()
    await app.finish(0)
    await until(() => !boxDialog() && container.querySelector('[aria-label="Box Studio Ops, 3 of 3"]'))
    expect(app.savedBoard().placements).toEqual(initialBoard.placements)
    expect(app.savedBoard().revision).toBe(8)
    expect(app.reads).toEqual(readsBefore)
    chat.unchanged()
})

test('Control Center moves use the latest revision and retry an uncertain result with the same receipt while preserving the chat', async () => {
    const app = fixture()
    const container = await app.mount()
    const chat = await openReviewer(container)
    const readsBefore = [...app.reads]
    await moveReviewerTo(projectId)
    await until(() => app.writes.length === 1)
    expect(app.writes[0]).toEqual({ requestId: expect.any(String), expectedRevision: 7, command: { kind: 'move-agent', agentId: reviewerId, spaceId: projectId } })
    chat.unchanged()
    await app.finish(0)
    await until(() => !container.querySelector('[role="alert"]') && composer())
    expect(app.savedBoard().placements.find(placed => placed.agentId === reviewerId)?.spaceId).toBe(projectId)
    chat.unchanged()

    await moveReviewerTo(mainId)
    await until(() => app.writes.length === 2)
    expect(app.writes[1]).toEqual({ requestId: expect.any(String), expectedRevision: 8, command: { kind: 'move-agent', agentId: reviewerId, spaceId: mainId } })
    expect(app.writes[1].requestId).not.toBe(app.writes[0].requestId)
    // The server applied it, but the client did not receive confirmation. Retry must reconcile
    // the same request rather than inventing a fresh move against a newer revision.
    await app.finish(1, true)
    const alert = await until(() => [...container.querySelectorAll<HTMLElement>('[role="alert"]')].find(item => item.textContent?.includes('Could not confirm this Box move')))
    chat.unchanged()
    await click('Retry', alert)
    await until(() => app.writes.length === 3)
    expect(app.writes[2]).toEqual(app.writes[1])
    await app.finish(2)
    await until(() => !container.querySelector('[role="alert"]'))
    expect(app.savedBoard().revision).toBe(9)
    expect(app.savedBoard().placements.find(placed => placed.agentId === reviewerId)?.spaceId).toBe(mainId)
    expect(app.savedBoard().placements.find(placed => placed.agentId === analystId)).toEqual(initialBoard.placements[1])
    expect(app.reads).toEqual(readsBefore)
    chat.unchanged()
})

test('selecting a Box member opens that owner’s saved chat and returns to the first owner’s independent draft', async () => {
    const app = fixture()
    const container = await app.mount()
    const original = await openReviewer(container)
    await act(async () => { expect(await flushDesktopDrafts()).toBe(true); cancelDraftShutdown() })
    await openCommands('Project team')
    await choose(`box-${projectId}`)
    expect(row(`box-coworker-${reviewerId}`)).toBeNull()
    await choose(`box-coworker-${analystId}`)
    await until(() => !commandField() && composer())
    const analystInput = composer()!
    const analystChat = analystInput.closest('[data-desktop-tab-active]')!
    await until(() => analystChat.textContent?.includes(replyOf(analystId)))
    expect(analystChat.textContent).not.toContain(replyOf(reviewerId))
    expect(analystInput.value).toBe('')
    expect(container.querySelector('[aria-label="Team board"]')).toBe(original.board)
    await enter(analystInput, 'Independent analyst draft')
    await act(async () => { expect(await flushDesktopDrafts()).toBe(true); cancelDraftShutdown() })

    await openCommands('Main team')
    await choose(`box-${mainId}`)
    expect(row(`box-coworker-${analystId}`)).toBeNull()
    await choose(`box-coworker-${reviewerId}`)
    await until(() => !commandField() && composer()?.value === draftText)
    await until(() => composer()!.closest('[data-desktop-tab-active]')!.textContent?.includes(replyOf(reviewerId)))
    expect(composer()!.closest('[data-desktop-tab-active]')!.textContent).not.toContain(replyOf(analystId))
    expect(container.querySelector('[aria-label="Team board"]')).toBe(original.board)
    expect(app.reads.some(path => path.includes(`chat-${analystId}`))).toBe(true)
    expect(app.writes).toEqual([])
    expect(app.savedBoard()).toEqual(initialBoard)
})
