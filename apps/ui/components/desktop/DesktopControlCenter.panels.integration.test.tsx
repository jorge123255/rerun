// @vitest-environment happy-dom
// Authored without execution. Root owns all test runs and native acceptance.
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act, type ReactNode } from 'react'
import type { UIMessage } from 'ai'
import { appendVoiceMarker, buildVoiceMarker } from '@rerun/contracts'
import { desktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { desktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import { fxCameraWriteSchema } from '@/lib/desktop/fx-repairs/board-camera'
import { desktopGettingStartedResponse } from '@/lib/desktop/getting-started/progress'
import { desktopMessages, desktopTranslator, type DesktopLanguage } from '@/lib/desktop/locale'
import { loadMessages } from '@rerun/i18n/messages'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { DesktopApp, type DesktopBootstrap } from './DesktopApp'
import { DesktopLocale } from './DesktopLocale'

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
const reviewer = { id: 'bca843a7-f2c6-461a-9b56-e8b77888fac1', name: 'Reviewer', description: 'Reviews', enabled: true, createdAt: date, updatedAt: date }
const auditor = { id: 'cbf9f65e-24bc-4563-9b8f-459c874b9064', name: 'Auditor', description: 'Audits', enabled: true, createdAt: date, updatedAt: date }
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
    if (title === 'Monitoring' || title === 'Apps') await click('Close', dialog)
    else await click(title === 'Edit coworker' ? 'Cancel' : 'Done', dialog)
    await until(() => !panelDialog(title))
}

function fixture(runStatus?: (sessionId: string, method: 'GET' | 'POST') => Promise<Response>, productionBoard = false, reply?: (sessionId: string) => string, history?: (sessionId: string) => UIMessage[]) {
    const boxId = '05699308-9d0d-412b-b3e5-69ef56bd2a0e'
    const board: DesktopBoardState = { revision: 1, spaces: [{ id: boxId, name: 'Review Box', col_start: 0, row_start: 0, col_end: 11, row_end: 7 }],
        placements: coworkers.map((agent, index) => ({ agentId: agent.id, spaceId: boxId, col: index * 3, row: 0 })) }
    let gettingStartedDismissed = false
    let roster = coworkers
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
    const fileReads: { agentId: string; route: string; path: string }[] = []
    const contentWrites: string[] = []
    const voiceAudioReads: string[] = []
    const managementWrites: { agentId: string; method: string; body: unknown }[] = []
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
        if (productionBoard && url.pathname === '/api/desktop/spaces' && method === 'GET') return Response.json({ board })
        if (productionBoard && url.pathname === '/api/desktop/workspaces/2/board-camera') {
            if (method === 'GET') return Response.json({ workspaceId: 2, revision: 0, camera: null })
            const { workspaceId, requestId, expectedRevision, camera } = fxCameraWriteSchema.parse(JSON.parse(String(init?.body)))
            return Response.json({ status: 'saved', requestId, snapshot: { workspaceId, revision: expectedRevision + 1, camera } })
        }
        if (productionBoard && url.pathname === '/api/desktop/getting-started') {
            if (method === 'POST') gettingStartedDismissed = JSON.parse(String(init?.body)).action === 'dismiss'
            return Response.json(desktopGettingStartedResponse(2, gettingStartedDismissed, { coworkers: 2, connectedProviders: 0, modelChats: 0, schedules: 0 }))
        }
        if (url.pathname === '/api/desktop/settings' && method === 'GET') return Response.json(providers)
        if (productionBoard && url.pathname === '/api/desktop/agents' && method === 'GET') return Response.json({ agents: roster })
        const managementOwner = roster.find(agent => url.pathname === `/api/desktop/agents/${agent.id}`)
        if (productionBoard && managementOwner && (method === 'PATCH' || method === 'DELETE')) {
            const body = JSON.parse(String(init?.body))
            managementWrites.push({ agentId: managementOwner.id, method, body })
            if (method === 'PATCH') {
                const agent = { ...managementOwner, name: body.name }
                roster = roster.map(item => item.id === agent.id ? agent : item)
                return Response.json({ agent })
            }
            if (body.confirmationName !== managementOwner.name) return Response.json({ error: 'Name does not match.' }, { status: 400 })
            roster = roster.filter(item => item.id !== managementOwner.id)
            board.placements = board.placements.filter(item => item.agentId !== managementOwner.id)
            return Response.json({ deletedAgentId: managementOwner.id })
        }
        if (url.pathname === '/api/desktop/board-activity') return Response.json({ agents: Object.fromEntries(coworkers.map(agent => [agent.id, 'idle'])) })
        if (url.pathname === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: date, checkedAt: date, nextCursor: null })
        if (url.pathname === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: date })
        if (url.pathname === '/api/desktop/conversations/search') return Response.json({ hits: [], hasMore: false })
        const servicesRoute = url.pathname.match(/^\/api\/desktop\/coworkers\/([^/]+)\/service-accounts$/)
        if (servicesRoute) {
            const agent = coworkers.find(item => item.id === decodeURIComponent(servicesRoute[1]))
            if (!agent || method !== 'GET') throw new Error('Unexpected Apps owner or mutation')
            panelReads.push(url.pathname)
            if (url.searchParams.get('view') === 'installed') return Response.json([])
            if (url.searchParams.get('view') === 'catalog') return Response.json({ services: [], total: 0 })
            throw new Error('Unexpected Apps view')
        }
        const agentRoute = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/(.+)$/)
        if (agentRoute) {
            const agentId = decodeURIComponent(agentRoute[1])
            const agent = coworkers.find(item => item.id === agentId)
            const route = agentRoute[2]
            if (!agent) throw new Error(`Unknown fixture coworker ${agentId}`)
            if (route === 'files/link' && method === 'POST') {
                const { href } = JSON.parse(String(init?.body))
                const prefix = '/data/agents/engine-reviewer/workspace/'
                if (agentId !== reviewer.id || !href.startsWith(prefix)) return Response.json({}, { status: 404 })
                return Response.json({ path: decodeURIComponent(href.slice(prefix.length)) })
            }
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
                if (route === 'files' || route === 'files/read') {
                    const path = url.searchParams.get('path') ?? ''
                    fileReads.push({ agentId, route, path })
                    if (route === 'files') return Response.json({ path, entries: [{ name: path === 'Reports' ? 'Q4 notes.md' : 'notes.md', type: 'file', size: 32, modifiedAt: date }] })
                    return Response.json({ path, content: `# ${agent.name} private file`, size: 32, truncated: false })
                }
                if (route === 'memories') return Response.json({ memories: [{ id: `${agentId}-note`, content: `${agent.name} private memory`, kind: 'fact', tags: [], createdAt: date, strength: 1, status: 'active' }] })
                if (route === 'tools') return Response.json({ rerun: [{ id: 'workspaceRead', label: `${agent.name} file access`, description: 'Read own workspace files', tools: ['fs_read'], enabled: false, available: true }], codex: [] })
                if (route === 'monitoring') return Response.json({ agentId, range: url.searchParams.get('range'), runs: [], errorRate: [], runsByStatus: [], runsByModel: [], totalTokens: null, cost: null, avgDuration: [], toolCalls: [], toolErrors: [] })
                if (route === 'settings') return Response.json({ soul: `${agent.name} private instructions`, verbosity: 'normal', soulEditable: true, workspaceReadEnabled: false, suggestedReplies: false, memoryEnabled: false, autoMemory: false, selfImprovementEnabled: true })
            }
        }
        if (url.pathname === `/api/desktop/coworkers/${reviewer.id}/voice` && method === 'GET' && url.searchParams.get('view') === 'audio') {
            voiceAudioReads.push(url.pathname + url.search)
            return new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'audio/webm' } })
        }
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.pathname.endsWith('/messages')) {
            messageReads.push(url.pathname)
            const id = decodeURIComponent(url.pathname.split('/')[4])
            return Response.json({ messages: history?.(id) ?? [{ id: `${id}-answer`, role: 'assistant', parts: [{ type: 'text', text: reply?.(id) ?? answer(id) }] }] })
        }
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/stop')) {
            if (runStatus && (method === 'GET' || method === 'POST')) return runStatus(decodeURIComponent(url.pathname.split('/')[4]), method)
            if (method === 'GET') return Response.json({ running: false })
        }
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        const background = desktopBackgroundRead(input, init); if (background) return background
        unexpected.push(`${method} ${raw}`)
        throw new Error(`Unexpected request: ${method} ${raw}`)
    }))
    return {
        panelReads, messageReads, fileReads, contentWrites, voiceAudioReads, managementWrites, layouts, answer,
        async mount(language?: DesktopLanguage) {
            const container = document.createElement('div')
            document.body.append(container)
            const root = createRoot(container)
            roots.add(root)
            const initialData: DesktopBootstrap = { ...providers, theme: 'dark', profile: { id: 1, displayName: 'Local' },
                workspace: { id: 1, name: 'Panel studio' }, ...(productionBoard ? { runtimeWorkspaceId: 2, runtimeLaunchNonce: 'test-board-launch', board } : {}), agents: roster, recentCoworkers: recent.snapshot() }
            const app = <DesktopApp initialData={initialData} />
            await act(async () => { root.render(language ? <DesktopLocale initial={language}>{app}</DesktopLocale> : app) })
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

test.each([
    { surface: 'Apps, Knowledge and Files', targets: [
        ['Apps', 'Apps', 'Connections for Reviewer'],
        ['Knowledge', 'Memories', 'Reviewer private memory'],
        ['Files', 'Files', 'notes.md'],
        ['Files', 'Files', 'notes.md'],
    ] },
    { surface: 'coworker capabilities and settings', targets: [
        ['Capabilities', 'Tools', 'Reviewer file access'],
        ['Skills', 'Skills', 'No skills yet'],
        ['Monitoring', 'Monitoring', 'No runs in the last 7 days'],
        ['Logs', 'Recent runs', 'Reviewer model'],
        ['Settings', 'Edit coworker', 'Reply length'],
    ] },
])('original coworker Open rows retain the board, reply and draft through $surface', async ({ targets }) => {
    const app = fixture()
    const mounted = await app.mount()
    const board = mounted.container.querySelector('[aria-label="Team board"]')!
    const input = await openBoardChat(mounted.container)
    const chat = input.closest('[data-desktop-tab-active]')!
    await until(() => chat.textContent?.includes(app.answer(`${reviewer.id}-first`)))
    await enter(input, 'Reviewer keeps this draft')
    const readsBefore = [...app.messageReads]
    for (const [row, title, expected] of targets) {
        await openCoworkerPage('Reviewer')
        await chooseOpenRow(row)
        const dialog = await until(() => panelDialog(title))
        await until(() => dialog.textContent?.includes(expected))
        if (row === 'Apps') await until(() => dialog.querySelector('[data-state="empty"]'))
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
    expect(app.panelReads.every(path => path.startsWith(`/api/desktop/agents/${reviewer.id}/`) ||
        path === `/api/desktop/coworkers/${reviewer.id}/service-accounts`)).toBe(true)
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

test('opens a saved workspace link in the owning Files panel and preserves the chat and draft', async () => {
    const prefix = '/data/agents/engine-reviewer/workspace/Reports/'
    const app = fixture(undefined, true, () => [
        `[Q4 review notes](${prefix}Q4%20notes.md)`,
        `[Missing report](${prefix}missing.md)`,
        '![Quarterly chart](Reports/chart.png)',
        '[Foreign report](/data/agents/engine-auditor/workspace/Reports/Q4%20notes.md)',
    ].join('\n\n'))
    const mounted = await app.mount()
    const input = await openBoardChat(mounted.container)
    await enter(input, 'Draft stays in chat')
    const link = await until(() => mounted.container.querySelector<HTMLButtonElement>('button[title="Open Reports/Q4 notes.md"]'))
    expect(mounted.container.querySelector('[title="Open Reports/Q4 notes.md"]')?.textContent).toBe('Q4 review notes')
    const image = await until(() => mounted.container.querySelector('img[alt="Quarterly chart"]'))
    expect(image.getAttribute('src')).toBe(`/api/desktop/agents/${reviewer.id}/files/image?path=Reports%2Fchart.png&animation=1`)
    expect(app.fileReads).toEqual([])
    await click('Foreign report', mounted.container)
    expect(panelDialog('Files')).toBeUndefined()
    expect(app.fileReads).toEqual([])

    await act(async () => link.click())
    const dialog = await until(() => panelDialog('Files'))
    await until(() => dialog.querySelector('[data-testid="file-preview"]'))
    expect(dialog.textContent).toContain('# Reviewer private file')
    expect(input.value).toBe('Draft stays in chat')
    expect(app.fileReads.slice(0, 2)).toEqual([
        { agentId: reviewer.id, route: 'files', path: 'Reports' },
        { agentId: reviewer.id, route: 'files/read', path: 'Reports/Q4 notes.md' },
    ])
    await click('Done', dialog)
    await until(() => document.activeElement === link)
    expect(composer()).toBe(input)

    await click('Missing report', mounted.container)
    const missing = await until(() => panelDialog('Files'))
    await until(() => missing.querySelector('[role="alert"]'))
    expect(missing.textContent).toContain('File not found. Reports/missing.md')
    expect(missing.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(app.fileReads.some(read => read.path === 'Reports/missing.md' || read.agentId !== reviewer.id)).toBe(false)
    await click('Done', missing)
    await until(() => !panelDialog('Files'))
    await mounted.unmount()
    const reopened = await app.mount()
    await openBoardChat(reopened.container)
    await until(() => reopened.container.querySelector('img[alt="Quarterly chart"]'))
    const restored = await until(() => reopened.container.querySelector<HTMLButtonElement>('button[title="Open Reports/Q4 notes.md"]'))
    await act(async () => restored.click())
    await until(() => panelDialog('Files')?.querySelector('[data-testid="file-preview"]'))
    expect(panelDialog('Files')?.textContent).toContain('# Reviewer private file')
})

test('reopens saved coworker Markdown from the board and keeps prompt dialogs and drafts intact', async () => {
    const link = '/data/agents/engine-reviewer/workspace/Reports/Q4%20notes.md'
    const content = (name: string) => `**${name}**\n\n[Open notes](${link})\n\n![Quarterly chart](Reports/chart.png)`
    const user = '@ada then @ada\n\nhttps://example.org/a/release\n\n' + content('Saved user message')
    const webhookPrompt = content('Webhook instructions') + '\n<trigger_payload trigger="synthetic" method="POST" content-type="application/json" bytes="11">\n{"ok":true}\n</trigger_payload>'
    const message = (id: string, text: string, metadata?: unknown): UIMessage =>
        ({ id, role: 'user', parts: [{ type: 'text', text }], metadata })
    const app = fixture(undefined, true, undefined, () => [
        message('saved-user', user, { coworkerMentions: [{ targetId: auditor.id, token: '@ada', start: 10, end: 14 }] }),
        message('saved-install', `<agent_install agent="Reviewer">\n${content('Install instructions')}\n</agent_install>`),
        message('saved-routine', `<scheduled_run schedule="daily" name="Daily QA">\n${content('Routine instructions')}\n</scheduled_run>`),
        message('saved-webhook', webhookPrompt),
    ])
    const mount = await app.mount()
    const input = await openBoardChat(mount.container)
    await enter(input, 'Keep this draft')
    const saved = await until(() => mount.container.querySelector('img[alt="Quarterly chart"]'))
    const messageBody = saved.closest('[data-chat-find-message]')!
    expect(messageBody.textContent).toContain('Saved user message')
    expect(messageBody.textContent).toContain('@ada then @ada')
    expect([...messageBody.querySelectorAll('span')].filter(span => span.textContent === '@ada')).toHaveLength(1)
    expect(messageBody.querySelector('[data-chat-find-url="https://example.org/a/release"]')?.textContent).toBe('example.org/…/release')

    const verifyFile = async (surface: ParentNode) => {
        const image = surface.querySelector('img[alt="Quarterly chart"]')
        expect(image?.getAttribute('src')).toBe(`/api/desktop/agents/${reviewer.id}/files/image?path=Reports%2Fchart.png&animation=1`)
        const opener = [...surface.querySelectorAll('button')].find(button => button.textContent === 'Open notes')!
        expect(opener).toBeDefined()
        await act(async () => opener.click())
        const files = await until(() => panelDialog('Files'))
        await until(() => files.querySelector('[data-testid="file-preview"]'))
        expect(files.textContent).toContain('# Reviewer private file')
        await click('Done', files)
        await until(() => !panelDialog('Files'))
        await until(() => document.activeElement === opener)
    }
    await verifyFile(messageBody)
    await click('View guide', mount.container)
    const guide = await until(() => panelDialog('Reviewer install guide'))
    await verifyFile(guide)
    await click('Close', guide)
    await until(() => !panelDialog('Reviewer install guide'))

    const openPrompt = async (divider: string, title: string) => {
        const promptButton = [...mount.container.querySelectorAll('button')].find(button =>
            button.textContent === 'View prompt' && button.parentElement?.textContent?.includes(divider))!
        expect(promptButton).toBeDefined()
        await act(async () => promptButton.click())
        return until(() => panelDialog(title))
    }
    const routine = await openPrompt('Daily QA', 'Daily QA prompt')
    await verifyFile(routine)
    await click('Close', routine)
    await until(() => !panelDialog('Daily QA prompt'))
    const webhook = await openPrompt('synthetic', 'synthetic prompt')
    await verifyFile(webhook)
    expect(webhook.textContent).not.toContain('{"ok":true}')
    await click('Close', webhook)
    await until(() => !panelDialog('synthetic prompt'))
    await click('View payload', mount.container)
    const payload = await until(() => panelDialog('synthetic payload'))
    expect(payload.textContent).toContain('"ok"')
    expect(payload.querySelector('img')).toBeNull()
    await click('Close', payload)
    expect(input.value).toBe('Keep this draft')
    expect(app.fileReads.filter(read => read.route === 'files/read')).toHaveLength(4)
    expect(app.fileReads.every(read => read.agentId === reviewer.id)).toBe(true)

    await mount.unmount()
    const restored = await app.mount()
    await openBoardChat(restored.container)
    const guideButton = await until(() => [...restored.container.querySelectorAll('button')].find(button => button.textContent === 'View guide'))
    await act(async () => guideButton.click())
    const restoredGuide = await until(() => panelDialog('Reviewer install guide'))
    await verifyFile(restoredGuide)
})

test('opens saved work steps from the board in order without hiding the reply or file result', async () => {
    const app = fixture(undefined, true, undefined, sessionId => [{
        id: 'engine-' + sessionId, role: 'assistant', parts: [
            { type: 'reasoning', text: 'Private provider analysis' },
            { type: 'reasoning', text: 'Checked the draft.', providerMetadata: desktopSummaryMetadata },
            { type: 'tool-fs_read', toolCallId: 'read', state: 'output-available', input: { path: 'notes/draft.md' }, output: 'Saved fixture text' },
            { type: 'text', text: 'Here is the result.' },
            { type: 'tool-card_file', toolCallId: 'file', state: 'output-available', input: {},
                output: { kind: 'file', files: [{ path: 'notes/draft.md', name: 'draft.md', size: 18, scope: 'agent' }] } },
            { type: 'tool-fs_read', toolCallId: 'refused', state: 'output-error', input: { path: 'notes/missing.md' }, errorText: 'File was not found.' },
        ],
    }])
    async function verify(container: HTMLElement) {
        const input = await openBoardChat(container)
        const chat = input.closest<HTMLElement>('[data-desktop-tab-active]')!
        const group = await until(() => chat.querySelector<HTMLButtonElement>('button[aria-label="2 steps"]'))
        const failed = chat.querySelector<HTMLButtonElement>('button[aria-label="1 step, 1 failed"]')!
        const card = chat.querySelector('[data-file-card]')!
        expect(card).not.toBeNull()
        expect(group.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(card.compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(chat.textContent).toContain('Here is the result.')
        expect(group.getAttribute('aria-expanded')).toBe('false')
        expect(failed.getAttribute('aria-expanded')).toBe('false')
        expect(chat.textContent).not.toContain('Checked the draft.')
        await act(async () => group.click())
        expect(group.getAttribute('aria-expanded')).toBe('true')
        expect(chat.textContent).toContain('Checked the draft.')
        const read = [...chat.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Read File'))!
        await act(async () => read.click())
        expect(chat.textContent).toContain('Saved fixture text')
        expect(chat.textContent).not.toContain('Private provider analysis')
        expect(chat.textContent).not.toContain('File was not found.')
        await act(async () => failed.click())
        expect(chat.textContent).toContain('File was not found.')
        expect(app.fileReads).toEqual([])
        expect(app.contentWrites).toEqual([])
    }
    const mounted = await app.mount()
    await verify(mounted.container)
    await mounted.unmount()
    const restored = await app.mount()
    await verify(restored.container)
})

test('a restored coworker run shows current activity only in its own tab and settles after Stop', async () => {
    const session = reviewer.id + '-first'
    let running = true
    let finishStop!: () => void
    const stopResponse = new Promise<void>(resolve => { finishStop = resolve })
    const stoppedSessions: string[] = []
    const app = fixture(async (id, method) => {
        if (method === 'POST') {
            stoppedSessions.push(id)
            await stopResponse
            running = false
            return Response.json({ status: 'cancelled' })
        }
        return Response.json({ running: id === session && running })
    }, true, undefined, id => [{
        id: 'engine-' + id,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Prior saved reply', state: 'streaming' }],
    }])
    const activity = (container: HTMLElement) => container.querySelector('[data-desktop-tab-active="true"] [data-chat-find-ignore] [role="status"]')
    const mounted = await app.mount()
    const input = await openBoardChat(mounted.container)
    const firstChat = input.closest('[data-desktop-tab-active]')!
    expect((await until(() => activity(mounted.container))).textContent).toBe('Thinking...')
    expect(firstChat.textContent).toContain('Prior saved reply')
    expect(firstChat.textContent).not.toContain('Writing...')

    await click('Reviewer second chat', mounted.container)
    await until(() => composer()?.closest('[data-desktop-tab-active]')?.textContent?.includes('Prior saved reply'))
    expect(activity(mounted.container)).toBeNull()

    await click('Reviewer first chat', mounted.container)
    await until(() => activity(mounted.container))
    await click('Stop', firstChat)
    expect((await until(() => activity(mounted.container))).textContent).toBe('Stopping the current run')
    expect(stoppedSessions).toEqual([session])
    await act(async () => finishStop())
    await until(() => !activity(mounted.container))
    expect(firstChat.textContent).toContain('Prior saved reply')

    await mounted.unmount()
    const reopened = await app.mount()
    await openBoardChat(reopened.container)
    await until(() => reopened.container.textContent?.includes('Prior saved reply'))
    expect(activity(reopened.container)).toBeNull()
    expect(stoppedSessions).toEqual([session])
})

test('reopens a saved coworker recording from the board and copies only the current transcript', async () => {
    const transcript = 'Café 👋  世界\nKeep the spacing.'
    const firstUrl = desktopVoiceAudioReference({ agentId: reviewer.id, tabUid: 'original-blank-tab' }, '11111111-1111-4111-8111-111111111111')
    const secondUrl = desktopVoiceAudioReference({ agentId: reviewer.id, tabUid: 'original-saved-tab', sessionId: reviewer.id + '-second' }, '22222222-2222-4222-8222-222222222222')
    const app = fixture(undefined, true, undefined, sessionId => [
        { id: 'engine-voice-' + sessionId, role: 'user', parts: [{ type: 'text', text: appendVoiceMarker(transcript,
            buildVoiceMarker({ src: sessionId.endsWith('-first') ? firstUrl : secondUrl, durationMs: 1200, levels: [0, 1] })) }] },
    ])
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { userActivation: { isActive: true } }))
    const setData = vi.fn()
    const previousCopy = Object.getOwnPropertyDescriptor(document, 'execCommand')
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => {
        const event = new Event('copy', { cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: { setData } })
        document.dispatchEvent(event)
        return event.defaultPrevented
    }) })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event('play'))
        return Promise.resolve()
    })
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event('pause'))
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const activeChat = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-desktop-tab-active="true"]')!
    try {
        const mounted = await app.mount()
        await openBoardChat(mounted.container)
        const first = activeChat(mounted.container)
        await until(() => first.querySelector('[aria-label="Play voice message"]'))
        expect(app.voiceAudioReads).toEqual([])
        await click('Transcript', first)
        const copy = [...first.querySelectorAll('button')].find(button => button.textContent === 'Copy transcript')!
        const ink = first.querySelector('[aria-label="Play voice message"]')?.closest('[data-ink]')
        expect(ink?.contains(copy)).toBe(false)
        expect(first.querySelector('[aria-hidden="false"] p')?.textContent).toBe(transcript)
        expect(first.querySelector('[data-heard]')).toBeNull()
        await act(async () => copy.click())
        expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', transcript)
        expect(app.voiceAudioReads).toEqual([])
        await click('Play voice message', first)
        expect(play).toHaveBeenCalledOnce()
        expect(app.voiceAudioReads).toEqual([firstUrl])
        pause.mockClear()

        await click('Reviewer second chat', mounted.container)
        await until(() => activeChat(mounted.container).querySelector('[aria-label="Play voice message"]'))
        expect(pause).toHaveBeenCalled()
        expect(revoke).toHaveBeenCalledWith('blob:recording')
        expect(copy.disabled).toBe(true)
        await act(async () => copy.click())
        expect(setData).toHaveBeenCalledOnce()
        expect(activeChat(mounted.container).textContent).not.toContain('Copied!')

        await mounted.unmount()
        const restored = await app.mount()
        await openBoardChat(restored.container)
        await click('Reviewer first chat', restored.container)
        const reopened = activeChat(restored.container)
        await until(() => reopened.querySelector('[aria-label="Play voice message"]'))
        await click('Transcript', reopened)
        await click('Copy transcript', reopened)
        expect(setData.mock.calls).toEqual([['text/plain', transcript], ['text/plain', transcript]])
        expect(app.voiceAudioReads).toEqual([firstUrl])
    } finally {
        if (previousCopy) Object.defineProperty(document, 'execCommand', previousCopy)
        else Reflect.deleteProperty(document, 'execCommand')
    }
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
    await chooseOpenRow('Apps')
    await until(() => panelDialog('Apps')?.textContent?.includes('Connections for Reviewer'))
    await until(() => panelDialog('Apps')?.querySelector('[data-state="empty"]'))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(first.value).toBe('First chat unsent draft')
    expect(second.value).toBe('Second chat unsent draft')
    await dismissPanel('Apps')
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
    await chooseOpenRow('Apps')
    await until(() => panelDialog('Apps')?.textContent?.includes('Connections for Reviewer'))
    await until(() => panelDialog('Apps')?.querySelector('[data-state="empty"]'))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    await dismissPanel('Apps')
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
    expect(app.panelReads.filter(path => path.endsWith('/service-accounts'))).toEqual(
        Array(4).fill(`/api/desktop/coworkers/${reviewer.id}/service-accounts`),
    )
    expect(app.contentWrites).toEqual([])
})


test('board tile Settings opens the exact coworker and keeps the active thread and draft across remount', async () => {
    const app = fixture()
    const mounted = await app.mount()
    const first = await openBoardChat(mounted.container)
    await click('Reviewer second chat', mounted.container)
    const second = await until(() => { const input = composer(); return input && input !== first ? input : null })
    await enter(second, 'Keep this draft while editing a coworker')

    const openSettings = async (container: HTMLElement, name: string) => {
        const tile = await until(() => container.querySelector<HTMLElement>(`[aria-label="Open chat with ${name}"]`))
        await act(async () => {
            tile.focus()
            tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
        })
        const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Settings')
        expect(action).toBeDefined()
        await act(async () => action!.click())
        const dialog = await until(() => panelDialog('Edit coworker'))
        await until(() => dialog.textContent?.includes('Reply length'))
        expect(dialog.textContent).toContain(name)
    }

    await openSettings(mounted.container, 'Auditor')
    await dismissPanel('Edit coworker')
    await openSettings(mounted.container, 'Reviewer')
    await dismissPanel('Edit coworker')
    expect(composer()?.value).toBe('Keep this draft while editing a coworker')
    expect(composer()?.closest('[data-desktop-tab-active]')?.textContent).toContain(app.answer(`${reviewer.id}-second`))
    expect(app.panelReads.filter(path => path.endsWith('/settings'))).toEqual([
        `/api/desktop/agents/${auditor.id}/settings`, `/api/desktop/agents/${reviewer.id}/settings`,
    ])

    await mounted.unmount()
    const reopened = await app.mount()
    await openSettings(reopened.container, 'Reviewer')
    await dismissPanel('Edit coworker')
    await until(() => composer()?.value === 'Keep this draft while editing a coworker')
    expect(app.contentWrites).toEqual([])
})

test('board coworker Settings pins notifications, preserves edits during rename, and deletes only the confirmed coworker', async () => {
    const app = fixture(undefined, true)
    const mounted = await app.mount()
    const chatDraft = await openBoardChat(mounted.container)
    await enter(chatDraft, 'Keep this chat draft during rename')
    await openCoworkerPage('Reviewer')
    await chooseOpenRow('Settings')
    const settings = await until(() => panelDialog('Edit coworker'))
    const instructions = await until(() => settings.querySelector<HTMLTextAreaElement>('textarea'))
    await enter(instructions, 'Unsaved instructions')

    await click('Notifications', settings)
    const notifications = await until(() => panelDialog('Notifications'))
    await until(() => notifications.querySelector('button[aria-label="Notifications for Reviewer"]'))
    expect(notifications.querySelector('button[aria-label="Notifications for Auditor"]')).toBeNull()
    await click('Close', notifications)
    await until(() => !panelDialog('Notifications'))
    expect(instructions.value).toBe('Unsaved instructions')

    await click('Rename', settings)
    const rename = await until(() => panelDialog('Rename coworker'))
    await enter(rename.querySelector('input')!, 'Analyst')
    await click('Rename', rename)
    await until(() => !panelDialog('Rename coworker'))
    expect(settings.textContent).toContain('Analyst')
    expect(instructions.value).toBe('Unsaved instructions')
    expect(chatDraft.value).toBe('Keep this chat draft during rename')
    expect(mounted.container.querySelector('[aria-label="Open chat with Analyst"]')).not.toBeNull()
    expect(app.contentWrites).toEqual([])

    await click('Delete', settings)
    const confirm = await until(() => document.querySelector<HTMLElement>('[role="alertdialog"]'))
    const name = confirm.querySelector('input')!
    const remove = [...confirm.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Delete')!
    await enter(name, 'Auditor')
    expect(remove.disabled).toBe(true)
    expect(app.managementWrites).toEqual([{ agentId: reviewer.id, method: 'PATCH', body: { name: 'Analyst' } }])
    await enter(name, 'Analyst')
    await click('Delete', confirm)
    await until(() => !mounted.container.querySelector('[aria-label="Open chat with Analyst"]'))
    expect(panelDialog('Edit coworker')).toBeUndefined()
    expect(mounted.container.querySelector('[aria-label="Open chat with Auditor"]')).not.toBeNull()
    expect(app.managementWrites).toEqual([
        { agentId: reviewer.id, method: 'PATCH', body: { name: 'Analyst' } },
        { agentId: reviewer.id, method: 'DELETE', body: { confirmationName: 'Analyst' } },
    ])
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


test('opens the current Box overview from the board and restores the checklist dismissal on remount', async () => {
    const app = fixture(undefined, true)
    const pill = 'Getting started: 1 of 3 done'
    const mounted = await app.mount()
    await until(() => mounted.container.querySelector(`[aria-label="${pill}"]`))
    await click(pill)
    await until(() => document.querySelector('[aria-label="Hide"]'))
    await click('Hide')
    await until(() => !mounted.container.querySelector(`[aria-label="${pill}"]`))
    await mounted.unmount()

    const restarted = await app.mount()
    await openBoardChat(restarted.container)
    await click('Coworker card')
    const details = await until(() => restarted.container.querySelector<HTMLElement>('section[aria-label="Coworker details"]:not([hidden])'))
    expect(details.textContent).toContain('Review Box')
    await click('Files', details)
    await until(() => details.textContent?.includes('Open Files'))
    await click('Open Files', details)
    await until(() => panelDialog('Files')?.textContent?.includes('notes.md'))
    await dismissPanel('Files')
    await click('Close panel', restarted.container.querySelector('section[aria-label="Coworker chat"] header')!)
    expect(restarted.container.querySelector(`[aria-label="${pill}"]`)).toBeNull()

    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })) })
    await enter(await until(commandField), 'Getting started')
    await chooseOpenRow('Getting started')
    await until(() => restarted.container.querySelector(`[aria-label="${pill}"]`))
})

test('reopens the localized workspace checklist from Help after a persisted dismissal', async () => {
    const app = fixture(undefined, true)
    const language: DesktopLanguage = { locale: 'fr', preference: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) }
    const t = desktopTranslator(language)
    const pill = t('gettingStarted.pillLabel', { done: 1, total: 3 })
    const hide = t('gettingStarted.hide')
    const mounted = await app.mount(language)
    await until(() => mounted.container.querySelector(`[aria-label="${pill}"]`))
    await click(pill)
    await until(() => document.querySelector(`[aria-label="${hide}"]`))
    expect(document.body.textContent).toContain('Connecter un modèle')
    expect(document.body.textContent).toContain(t('gettingStarted.steps.schedule.title'))
    await click(hide)
    await until(() => !mounted.container.querySelector(`[aria-label="${pill}"]`))
    await mounted.unmount()

    const restarted = await app.mount(language)
    expect(restarted.container.querySelector(`[aria-label="${pill}"]`)).toBeNull()
    await click('Aide')
    const help = await until(() => panelDialog('Aide'))
    await click('Premiers pas', help)
    await until(() => restarted.container.querySelector(`[aria-label="${pill}"]`))
    await until(() => document.querySelector(`[aria-label="${hide}"]`))
    expect(document.body.textContent).toContain('Connecter un modèle')
    expect(app.contentWrites).toEqual([])
})
