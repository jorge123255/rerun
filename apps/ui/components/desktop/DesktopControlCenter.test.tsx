// @vitest-environment happy-dom
// Authored for the control-center lane; the integration owner runs all validation.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { DesktopControlCenter } from './DesktopControlCenter'
import { flushDesktopRecentCoworkers, resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import type { DesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers.schema'
import type { DesktopControlCenterChats, DesktopOpenChat } from '@/lib/desktop/control-center-chats'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep the original command list, dialog and keyboard behavior; only native animations are
// removed because happy-dom rejects their cancellation promises when the dialog unmounts.
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

const rendered = vi.hoisted(() => ({ view: undefined as Parameters<typeof import('@/components/control-center/ControlCenterView')['ControlCenterView']>[0] | undefined }))
vi.mock('@/components/control-center/ControlCenterView', async original => {
    const actual = await original<typeof import('@/components/control-center/ControlCenterView')>()
    return { ...actual, ControlCenterView: (props: Parameters<typeof actual.ControlCenterView>[0]) => {
        rendered.view = props
        return <actual.ControlCenterView {...props} />
    } }
})

const coworker = (id: string, name = id, description = '', enabled?: boolean) =>
    ({ id, name, description, createdAt: '', updatedAt: '', ...(enabled === undefined ? {} : { enabled }) })
const hit = (id: string, agentId: string, agentName: string, title: string): DesktopConversationHit =>
    ({ id, agentId, agentName, title })
const openChat = (tabUid: string, sessionId: string | null, title = 'New conversation', agentId = 'ada'): DesktopOpenChat => ({ agentId, tabUid, sessionId, title })
const chatList = (agentId = 'ada', overrides: Partial<DesktopControlCenterChats> = {}): DesktopControlCenterChats => ({ agentId, openChats: [], recentChats: [], recentStatus: 'ok', hasMore: false, ...overrides })

const dialog = () => document.querySelector('[role="dialog"]')
const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
const field = () => dialog()!.querySelector<HTMLInputElement>('input')!

const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
})

const type = async (value: string) => act(async () => {
    const input = field()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
})

const clickRow = async (text: string) => {
    const row = rows().find(item => item.textContent?.includes(text))
    expect(row, text).toBeTruthy()
    await act(async () => { row!.click() })
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })

type Overrides = {
    initialRecent?: DesktopRecentCoworkers
    open?: boolean
    onOpenChange?: (open: boolean) => void
    disabled?: boolean
    coworkers?: Parameters<typeof DesktopControlCenter>[0]['coworkers']
    selectedCoworkerId?: string | null
    onOpenConversation?: (hit: DesktopConversationHit) => void
    onOpenCoworker?: (agentId: string) => void
    onOpenCoworkerPanel?: Parameters<typeof DesktopControlCenter>[0]['onOpenCoworkerPanel']
    onOpenChat?: (target: DesktopOpenChat) => void
    onAddCoworker?: () => void
    onModelSettings?: () => void
    onBackToBoard?: () => void
    onWorkspaceSettings?: () => void
    onRecenterBoard?: () => void
    onToggleTheme?: () => void
    darkTheme?: boolean
}

const roots = new Set<Root>()
function mount() {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.add(root)
    const unmount = root.unmount.bind(root)
    root.unmount = () => { roots.delete(root); unmount() }
    return { container, root }
}

beforeEach(() => {
    resetDesktopRecentCoworkers()
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const match = url.match(/^\/api\/desktop\/agents\/([^/]+)\/control-center-chats$/)
        if (match) return Response.json(chatList(decodeURIComponent(match[1])))
        throw new Error(`Unexpected request ${url}`)
    }))
})
afterEach(async () => {
    for (const root of roots) await act(async () => { root.unmount() })
    document.body.innerHTML = ''
    rendered.view = undefined
    resetDesktopRecentCoworkers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const render = (root: ReturnType<typeof createRoot>, overrides: Overrides = {}) => act(async () => {
    root.render(<DesktopControlCenter
        initialRecent={overrides.initialRecent}
        open={overrides.open}
        onOpenChange={overrides.onOpenChange}
        disabled={overrides.disabled}
        coworkers={overrides.coworkers ?? [coworker('ada', 'Ada', 'Files summaries'), coworker('bob', 'Bob'), coworker('cy', 'Cy', '', false)]}
        selectedCoworkerId={overrides.selectedCoworkerId ?? null}
        onOpenConversation={overrides.onOpenConversation ?? (() => {})}
        onOpenCoworker={overrides.onOpenCoworker}
        onOpenCoworkerPanel={overrides.onOpenCoworkerPanel}
        onOpenChat={overrides.onOpenChat}
        onAddCoworker={overrides.onAddCoworker ?? (() => {})}
        onModelSettings={overrides.onModelSettings ?? (() => {})}
        onBackToBoard={overrides.onBackToBoard ?? (() => {})}
        onWorkspaceSettings={overrides.onWorkspaceSettings}
        onRecenterBoard={overrides.onRecenterBoard}
        onToggleTheme={overrides.onToggleTheme}
        darkTheme={overrides.darkTheme} />)
})

test('⌘F opens and closes the center and claims nothing else, ⌘K toggles where nothing holds it, and Ctrl+F stays a caret key', async () => {
    const { root } = mount()
    await render(root)
    expect(dialog()).toBeNull()
    await press('f', { metaKey: true })
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('Add coworker')
    // Pressed while open it only closes it, like the original.
    await press('f', { metaKey: true })
    expect(dialog()).toBeNull()
    // On a Mac Ctrl+F moves the caret in a text field instead.
    await press('f', { ctrlKey: true })
    expect(dialog()).toBeNull()
    // Shift and Alt never trigger the center.
    await press('f', { metaKey: true, shiftKey: true })
    expect(dialog()).toBeNull()
    await press('f', { metaKey: true })
    expect(dialog()).not.toBeNull()
    await press('f', { metaKey: true, altKey: true })
    expect(dialog()).not.toBeNull()
    await press('f', { metaKey: true })
    expect(dialog()).toBeNull()
    // With no chat open and no field under the caret, ⌘K toggles the center as ⌘F does.
    await press('k', { metaKey: true })
    expect(dialog()).not.toBeNull()
    await press('k', { metaKey: true })
    expect(dialog()).toBeNull()
})

test('an open coworker chat and an editing field keep ⌘K, while ⌘F still opens from a field', async () => {
    const { root } = mount()
    await render(root, { selectedCoworkerId: 'ada' })
    await press('k', { metaKey: true })
    expect(dialog()).toBeNull()
    const composer = document.createElement('input')
    composer.setAttribute('type', 'text')
    document.body.append(composer)
    composer.focus()
    await render(root, { selectedCoworkerId: null })
    await press('k', { metaKey: true })
    expect(dialog()).toBeNull()
    // ⌘F follows the original even from a field.
    await press('f', { metaKey: true })
    expect(dialog()).not.toBeNull()
    // With the center open, ⌘K still just closes it.
    await press('k', { metaKey: true })
    expect(dialog()).toBeNull()
    composer.blur()
    composer.remove()
    await press('k', { metaKey: true })
    expect(dialog()).not.toBeNull()
})

test('the root page remembers a selection as Recent and exposes only the three supported actions', async () => {
    const { root } = mount()
    const actions = { onOpenConversation: vi.fn(), onAddCoworker: vi.fn(), onModelSettings: vi.fn(), onBackToBoard: vi.fn() }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('/api/desktop/conversations/search')) return Response.json({ hits: [], hasMore: false })
        throw new Error(`Unexpected request ${url}`)
    }))
    try {
        await render(root, { initialRecent: { revision: 1, recentAgentIds: ['ada'] }, selectedCoworkerId: 'ada', ...actions })
        await press('f', { metaKey: true })
        expect(dialog()!.textContent).toContain('Recent')
        expect(rows()[0]!.textContent).toContain('Ada')
        expect(dialog()!.textContent).toContain('Actions')
        expect(dialog()!.textContent).toContain('Settings')
        for (const absent of ['Billing', 'Browse templates', 'Ask Rerun', 'Shared files', 'Contact Support', 'What’s new', 'Company Brain', 'Workspace settings', 'Recenter the board', 'Switch to light theme', 'Switch to dark theme']) {
            expect(dialog()!.textContent).not.toContain(absent)
        }
        await clickRow('Add coworker')
        expect(actions.onAddCoworker).toHaveBeenCalledTimes(1)
        expect(dialog()).toBeNull()
        await press('f', { metaKey: true })
        await clickRow('Model settings')
        expect(actions.onModelSettings).toHaveBeenCalledTimes(1)
        expect(dialog()).toBeNull()
        await press('f', { metaKey: true })
        await clickRow('Team board')
        expect(actions.onBackToBoard).toHaveBeenCalledTimes(1)
        expect(dialog()).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('supported workspace, recenter and appearance commands use original labels and keyword search', async () => {
    const { root } = mount()
    const actions = { onWorkspaceSettings: vi.fn(), onRecenterBoard: vi.fn(), onToggleTheme: vi.fn() }
    await render(root, { ...actions, darkTheme: true })
    await press('f', { metaKey: true })
    await type('/logo')
    expect(rows()).toHaveLength(1)
    await clickRow('Workspace settings')
    expect(actions.onWorkspaceSettings).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()

    await press('f', { metaKey: true })
    await type('/reset view')
    expect(rows()).toHaveLength(1)
    await clickRow('Recenter the board')
    expect(actions.onRecenterBoard).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()

    await press('f', { metaKey: true })
    await type('/appearance')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('Switch to light theme')
    await clickRow('Switch to light theme')
    expect(actions.onToggleTheme).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()

    await press('f', { metaKey: true })
    await type('/delete')
    expect(rows()).toHaveLength(0)
    expect(actions.onWorkspaceSettings).toHaveBeenCalledTimes(1)
})

test('removed optional command callbacks disappear and retained rows cannot close the center', async () => {
    const { root } = mount()
    const onOpenChange = vi.fn()
    const actions = { onWorkspaceSettings: vi.fn(), onRecenterBoard: vi.fn(), onToggleTheme: vi.fn() }
    await render(root, { open: true, onOpenChange, ...actions })
    const retained = rendered.view!.sections.flatMap(section => section.rows)
        .filter(row => ['command-workspace_settings', 'command-recenter_board', 'command-toggle_theme'].includes(row.id))
    expect(retained).toHaveLength(3)
    await render(root, { open: true, onOpenChange })
    const ids = rendered.view!.sections.flatMap(section => section.rows).map(row => row.id)
    expect(ids).not.toContain('command-workspace_settings')
    expect(ids).not.toContain('command-recenter_board')
    expect(ids).not.toContain('command-toggle_theme')
    await act(async () => { retained.forEach(row => row.onSelect()) })
    expect(onOpenChange).not.toHaveBeenCalled()
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
})

test('theme command follows resolved appearance and rejects an old row with the opposite meaning', async () => {
    const { root } = mount()
    const onOpenChange = vi.fn()
    const onToggleTheme = vi.fn()
    await render(root, { open: true, onOpenChange, onToggleTheme, darkTheme: true })
    const toLight = rendered.view!.sections.flatMap(section => section.rows).find(row => row.id === 'command-toggle_theme')!
    expect(toLight.label).toBe('Switch to light theme')
    await render(root, { open: true, onOpenChange, onToggleTheme, darkTheme: false })
    expect(dialog()!.textContent).toContain('Switch to dark theme')
    expect(dialog()!.textContent).not.toContain('Switch to light theme')
    await act(async () => { toLight.onSelect() })
    expect(onToggleTheme).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    await clickRow('Switch to dark theme')
    expect(onToggleTheme).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})

test('workspace navigation uses the latest callback and stale command search rows do nothing', async () => {
    const { root } = mount()
    const oldWorkspace = vi.fn()
    const currentWorkspace = vi.fn()
    const onRecenterBoard = vi.fn()
    const onOpenChange = vi.fn()
    await render(root, { open: true, onOpenChange, onWorkspaceSettings: oldWorkspace, onRecenterBoard })
    const retained = rendered.view!.sections.flatMap(section => section.rows)
    const recenter = retained.find(row => row.id === 'command-recenter_board')!
    const workspace = retained.find(row => row.id === 'command-workspace_settings')!
    await render(root, { open: true, onOpenChange, onWorkspaceSettings: currentWorkspace, onRecenterBoard })
    await act(async () => { workspace.onSelect() })
    expect(oldWorkspace).not.toHaveBeenCalled()
    expect(currentWorkspace).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    await render(root, { open: false, onOpenChange, onWorkspaceSettings: currentWorkspace, onRecenterBoard })
    await render(root, { open: true, onOpenChange, onWorkspaceSettings: currentWorkspace, onRecenterBoard })
    await type('/logo')
    onOpenChange.mockClear()
    await act(async () => { recenter.onSelect() })
    expect(onRecenterBoard).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
})

test('coworker drill lists only the supported original Open tabs before its saved chats', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(chatList('ada', {
        openChats: [openChat('draft-tab', null)],
        recentChats: [hit('saved-chat', 'ada', 'Ada', 'Saved reply')],
    }))))
    const { root } = mount()
    const onOpenCoworkerPanel = vi.fn()
    await render(root, { onOpenCoworkerPanel })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    await settle()
    const sections = rendered.view!.sections
    expect(sections[0]!.heading).toBe('Open')
    expect(sections[0]!.rows.map(row => [row.id, row.label, row.detail])).toEqual([
        ['tab-chat', 'Chat', 'Talk with this coworker'],
        ['tab-mcp', 'MCP', 'Model Context Protocol servers'],
        ['tab-data', 'Database', "This coworker's data"],
        ['tab-memories', 'Knowledge', 'What this coworker remembers'],
        ['tab-files', 'Files', "This coworker's files"],
        ['tab-scheduled', 'Routines', 'Recurring and scheduled tasks'],
        ['tab-tools', 'Capabilities', 'Tools this coworker can use'],
        ['tab-monitoring', 'Monitoring', 'Usage, cost and activity for this coworker'],
        ['tab-logs', 'Logs', 'Activity and run logs'],
        ['tab-settings', 'Settings', 'Configure this coworker'],
    ])
    expect(sections[0]!.rows.every(row => row.leading.kind === 'icon')).toBe(true)
    expect(sections.slice(1).map(section => section.heading)).toEqual(['Open chats', 'Recent conversations'])
    for (const absent of ['Triggers', 'Apps', 'Skills', 'To handle', 'Install']) {
        expect(sections[0]!.rows.some(row => row.label === absent)).toBe(false)
    }
    await clickRow('Knowledge')
    expect(onOpenCoworkerPanel).toHaveBeenCalledExactlyOnceWith('ada', 'memories')
    expect(dialog()).toBeNull()
})

test('coworker query prefixes keep Files and Settings scoped instead of exposing workspace commands', async () => {
    const { root } = mount()
    const onOpenCoworkerPanel = vi.fn()
    const onWorkspaceSettings = vi.fn()
    const onModelSettings = vi.fn()
    const fetcher = vi.fn(async (url: string) => url.includes('/control-center-chats')
        ? Response.json(chatList())
        : Response.json({ hits: [], hasMore: false }))
    vi.stubGlobal('fetch', fetcher)
    await render(root, { onOpenCoworkerPanel, onWorkspaceSettings, onModelSettings })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    await type('/settings')
    await settle()
    expect(rendered.view!.sections[0]!.rows.map(row => row.id)).toEqual(['tab-settings'])
    expect(dialog()!.textContent).not.toContain('Workspace settings')
    expect(dialog()!.textContent).not.toContain('Model settings')
    await clickRow('Settings')
    expect(onOpenCoworkerPanel).toHaveBeenLastCalledWith('ada', 'settings')
    expect(onWorkspaceSettings).not.toHaveBeenCalled()
    expect(onModelSettings).not.toHaveBeenCalled()

    await press('f', { metaKey: true })
    await clickRow('Ada')
    await type('@files')
    await settle()
    expect(rendered.view!.sections[0]!.rows.map(row => row.id)).toEqual(['tab-files'])
    expect(rows().some(row => row.textContent?.includes('Bob'))).toBe(false)
    await clickRow('Files')
    expect(onOpenCoworkerPanel).toHaveBeenLastCalledWith('ada', 'files')
    expect(onOpenCoworkerPanel).toHaveBeenCalledTimes(2)
    const searches = fetcher.mock.calls.map(([url]) => url).filter(url => url.startsWith('/api/desktop/conversations/search'))
    expect(searches).toHaveLength(2)
    expect(searches.every(url => new URL(url, 'http://local').searchParams.get('agentId') === 'ada')).toBe(true)
})

test.each(['callback removed', 'owner removed', 'center disabled'] as const)('retained coworker Open rows cannot navigate after %s', async condition => {
    const { root } = mount()
    const onOpenCoworkerPanel = vi.fn()
    const onOpenChange = vi.fn()
    await render(root, { open: true, onOpenChange, onOpenCoworkerPanel })
    await clickRow('Ada')
    const selected = rendered.view!.sections[0]!.rows.find(row => row.id === 'tab-files')!.onSelect
    await render(root, {
        open: true, onOpenChange,
        onOpenCoworkerPanel: condition === 'callback removed' ? undefined : onOpenCoworkerPanel,
        coworkers: condition === 'owner removed' ? [coworker('bob', 'Bob')] : undefined,
        disabled: condition === 'center disabled',
    })
    if (condition === 'callback removed') expect(rendered.view!.sections.some(section => section.id === 'coworker-open')).toBe(false)
    onOpenChange.mockClear()
    await act(async () => { selected() })
    expect(onOpenCoworkerPanel).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

test('coworker Open rows use the current callback and cannot jump back to a previous owner', async () => {
    const { root } = mount()
    const oldOpen = vi.fn()
    const currentOpen = vi.fn()
    await render(root, { onOpenCoworkerPanel: oldOpen })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    const oldAdaFiles = rendered.view!.sections[0]!.rows.find(row => row.id === 'tab-files')!.onSelect
    await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })) })
    await clickRow('Bob')
    const bobFiles = rendered.view!.sections[0]!.rows.find(row => row.id === 'tab-files')!.onSelect
    await render(root, { onOpenCoworkerPanel: currentOpen })
    await act(async () => { oldAdaFiles() })
    expect(oldOpen).not.toHaveBeenCalled()
    expect(currentOpen).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
    await act(async () => { bobFiles() })
    expect(oldOpen).not.toHaveBeenCalled()
    expect(currentOpen).toHaveBeenCalledExactlyOnceWith('bob', 'files')
    expect(dialog()).toBeNull()
})

test('a quit that begins while a coworker drill is open blocks its retained panel row', async () => {
    const { root } = mount()
    const onOpenCoworkerPanel = vi.fn()
    const onOpenChange = vi.fn()
    await render(root, { open: true, onOpenChange, onOpenCoworkerPanel })
    await clickRow('Ada')
    const selected = rendered.view!.sections[0]!.rows.find(row => row.id === 'tab-monitoring')!.onSelect
    const drafts = await import('@/lib/desktop/draft-writes')
    vi.spyOn(drafts, 'isDesktopQuitting').mockReturnValue(true)
    await act(async () => { selected() })
    expect(onOpenCoworkerPanel).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

test('searching ranks coworkers, keeps a disabled coworker’s Off badge, and narrows on @ and /', async () => {
    const { root } = mount()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('/api/desktop/conversations/search')) return Response.json({ hits: [], hasMore: false })
        throw new Error(`Unexpected request ${url}`)
    }))
    try {
        await render(root)
        await press('f', { metaKey: true })
        // Without text the plain list caps the others and marks a disabled coworker.
        expect(dialog()!.textContent).toContain('Off')
        await type('cy')
        const listed = rows().map(item => item.textContent ?? '')
        expect(listed.some(text => text.includes('Cy'))).toBe(true)
        expect(listed.some(text => text.includes('Ada'))).toBe(false)
        await type('@bo')
        expect(rows().some(item => item.textContent?.includes('Bob'))).toBe(true)
        expect(dialog()!.textContent).not.toContain('Add coworker')
        expect(dialog()!.textContent).not.toContain('Model settings')
        await type('/model')
        expect(dialog()!.textContent).toContain('Model settings')
        expect(rows().some(item => item.textContent?.includes('Ada'))).toBe(false)
        expect(dialog()!.textContent).not.toContain('Team board')
        await clickRow('Model settings')
        expect(dialog()).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('conversations come from the local title search, with loading, no results and stale reads kept apart', async () => {
    const { root } = mount()
    const onOpenConversation = vi.fn()
    let finishStale!: (response: Response) => void
    const fetcher = vi.fn(async (url: string) => {
            const query = new URL(url, 'http://local').searchParams.get('q')
            if (query === 'silver') return new Promise<Response>(resolve => { finishStale = resolve })
            if (query === 'brass') return Response.json({ hits: [hit('ada-1', 'ada', 'Ada', 'Brass rehearsal'), hit('bob-1', 'bob', 'Bob', 'Brass band')], hasMore: false })
            if (query === 'gold') return Response.json({ hits: [hit('ada-2', 'ada', 'Ada', 'Gold notes')], hasMore: false })
            return Response.json({ hits: [], hasMore: false })
        })
    vi.stubGlobal('fetch', fetcher)
    try {
        await render(root, { onOpenConversation })
        await press('f', { metaKey: true })
        await type('brass')
        expect(dialog()!.textContent).toContain('Conversations')
        expect(dialog()!.textContent).not.toContain('Nothing matches.')
        await settle()
        expect(dialog()!.textContent).toContain('Brass rehearsal')
        expect(dialog()!.textContent).toContain('Brass band')
        expect(dialog()!.textContent).toContain('Ada')
        expect(dialog()!.textContent).toContain('Bob')
        // A newer query cancels the older read: its answer never lands.
        await type('silver')
        await settle()
        await type('gold')
        await settle()
        expect(dialog()!.textContent).toContain('Gold notes')
        expect(dialog()!.textContent).not.toContain('Brass rehearsal')
        await act(async () => { finishStale(Response.json({ hits: [hit('late', 'ada', 'Ada', 'Late brass')], hasMore: false })) })
        expect(dialog()!.textContent).toContain('Gold notes')
        expect(dialog()!.textContent).not.toContain('Late brass')
        // Opening a hit selects the exact conversation and closes the center.
        await clickRow('Gold notes')
        expect(onOpenConversation).toHaveBeenCalledTimes(1)
        expect(onOpenConversation).toHaveBeenCalledWith(hit('ada-2', 'ada', 'Ada', 'Gold notes'))
        expect(dialog()).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('a failed search is distinct from no results and retries from its own row', async () => {
    const { root } = mount()
    let brassAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const query = new URL(url, 'http://local').searchParams.get('q')
        if (query === 'brass') {
            brassAttempts++
            if (brassAttempts === 1) return Response.json({ error: 'unavailable' }, { status: 503 })
            return Response.json({ hits: [hit('ada-1', 'ada', 'Ada', 'Brass rehearsal')], hasMore: false })
        }
        return Response.json({ hits: [], hasMore: false })
    }))
    try {
        await render(root)
        await press('f', { metaKey: true })
        await type('brass')
        await settle()
        expect(brassAttempts).toBe(1)
        expect(dialog()!.textContent).toContain('Could not search saved chats')
        expect(dialog()!.textContent).toContain('Try again')
        expect(dialog()!.textContent).not.toContain('Nothing matches.')
        await clickRow('Could not search saved chats')
        await settle()
        expect(brassAttempts).toBe(2)
        expect(dialog()!.textContent).toContain('Brass rehearsal')
        await type('gold')
        await settle()
        expect(dialog()!.textContent).toContain('Nothing matches.')
        expect(dialog()!.textContent).not.toContain('Could not search saved chats')
    } finally { await act(async () => { root.unmount() }) }
})

test('a standalone coworker drill scopes the request and results, and Backspace returns', async () => {
    const { root } = mount()
    const onOpenConversation = vi.fn()
    const fetcher = vi.fn(async (url: string) => {
        if (url.endsWith('/control-center-chats')) return Response.json(chatList('ada'))
        const query = new URL(url, 'http://local').searchParams.get('q')
        if (query === 'plan') return Response.json({ hits: [hit('ada-1', 'ada', 'Ada', 'Shared plan'), hit('bob-1', 'bob', 'Bob', 'Shared plan')], hasMore: false })
        return Response.json({ hits: [], hasMore: false })
    })
    vi.stubGlobal('fetch', fetcher)
    try {
        await render(root, { onOpenConversation })
        await press('f', { metaKey: true })
        await clickRow('Ada')
        expect(field().getAttribute('placeholder')).toBe('Search in Ada…')
        expect(dialog()!.textContent).toContain('No open chats or recent conversations yet.')
        await type('plan')
        await settle()
        expect(new URL(fetcher.mock.calls.at(-1)![0], 'http://local').searchParams.get('agentId')).toBe('ada')
        // Only Ada's identical title is listed here; Bob's stays out of her page.
        expect(rows()).toHaveLength(1)
        expect(rows()[0]!.textContent).toContain('Shared plan')
        await clickRow('Shared plan')
        expect(onOpenConversation).toHaveBeenCalledTimes(1)
        expect(onOpenConversation).toHaveBeenCalledWith(hit('ada-1', 'ada', 'Ada', 'Shared plan'))
        // Tab drills out of the first row instead of leaving the field, like the original.
        await press('f', { metaKey: true })
        await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
        expect(field().getAttribute('placeholder')).toBe('Search in Ada…')
        // Backspace on an empty field walks back out of the drilled page.
        await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })) })
        expect(field().getAttribute('placeholder')).toBe('Search coworkers, settings, conversations…')
    } finally { await act(async () => { root.unmount() }) }
})

test('does not open over an existing dialog or alert, or while disabled', async () => {
    const { root } = mount()
    await render(root)
    for (const role of ['dialog', 'alertdialog']) {
        const existing = document.body.appendChild(document.createElement('div'))
        existing.setAttribute('role', role)
        existing.textContent = 'Existing overlay'
        await press('f', { metaKey: true })
        await press('k', { metaKey: true })
        expect(document.body.textContent).not.toContain('Control center')
        expect(existing.isConnected).toBe(true)
        existing.remove()
    }
    await render(root, { disabled: true })
    await press('f', { metaKey: true })
    await press('k', { metaKey: true })
    expect(dialog()).toBeNull()
    const onOpenChange = vi.fn()
    await render(root, { open: true, disabled: true, onOpenChange })
    expect(dialog()).toBeNull()
    expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('controlled Enter opens the coworker while Tab drills without navigating', async () => {
    const { root } = mount()
    const onOpenChange = vi.fn()
    const onOpenCoworker = vi.fn()
    const props = { open: true, onOpenChange, onOpenCoworker }
    await render(root, props)
    await clickRow('Ada')
    expect(onOpenCoworker).toHaveBeenCalledExactlyOnceWith('ada')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await render(root, { ...props, open: false })
    await render(root, props)
    await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(field().placeholder).toBe('Search in Ada…')
    expect(onOpenCoworker).toHaveBeenCalledTimes(1)
})

test('reopening the same query requires a new answer and rejects a retained prior row callback', async () => {
    const { root } = mount()
    const onOpenConversation = vi.fn()
    let finishRefresh!: (response: Response) => void
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ hits: [hit('old', 'ada', 'Ada', 'Plan before reopening')], hasMore: false }))
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finishRefresh = resolve }))
    vi.stubGlobal('fetch', fetcher)
    await render(root, { onOpenConversation })
    await press('f', { metaKey: true })
    await type('plan')
    await settle()
    const oldSelect = rendered.view!.sections.flatMap(section => section.rows).find(row => row.id.endsWith('-old'))!.onSelect
    expect(dialog()!.textContent).toContain('Plan before reopening')
    await press('f', { metaKey: true })
    await press('f', { metaKey: true })
    await type('plan')
    expect(dialog()!.textContent).not.toContain('Plan before reopening')
    expect(dialog()!.textContent).not.toContain('Nothing matches.')
    await act(async () => { oldSelect() })
    expect(onOpenConversation).not.toHaveBeenCalled()
    await settle()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { finishRefresh(Response.json({ hits: [hit('new', 'ada', 'Ada', 'Plan after reopening')], hasMore: false })) })
    expect(dialog()!.textContent).toContain('Plan after reopening')
    await clickRow('Plan after reopening')
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith(hit('new', 'ada', 'Ada', 'Plan after reopening'))
})

test('hides removed owners and rejects retained callbacks after roster changes or disabling', async () => {
    const { root } = mount()
    const onOpenConversation = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hits: [
        hit('ada-chat', 'ada', 'Old Ada name', 'Plan for Ada'),
        hit('bob-chat', 'bob', 'Bob', 'Plan for Bob'),
        hit('foreign', 'gone', 'Gone', 'Plan for removed coworker'),
    ], hasMore: false })))
    await render(root, { onOpenConversation })
    await press('f', { metaKey: true })
    await type('plan')
    await settle()
    expect(dialog()!.textContent).not.toContain('Plan for removed coworker')
    const oldRows = rendered.view!.sections.flatMap(section => section.rows)
    const selectAda = oldRows.find(row => row.id.endsWith('-ada-chat'))!.onSelect
    const selectBob = oldRows.find(row => row.id.endsWith('-bob-chat'))!.onSelect
    await render(root, { onOpenConversation, coworkers: [coworker('bob', 'Robert')] })
    expect(dialog()!.textContent).not.toContain('Plan for Ada')
    await act(async () => { selectAda() })
    expect(onOpenConversation).not.toHaveBeenCalled()
    await act(async () => { selectBob() })
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith(hit('bob-chat', 'bob', 'Robert', 'Plan for Bob'))

    await press('f', { metaKey: true })
    const command = rendered.view!.sections.flatMap(section => section.rows).find(row => row.id === 'command-model_settings')!.onSelect
    const onModelSettings = vi.fn()
    await render(root, { disabled: true, onModelSettings })
    await act(async () => { command(); selectBob() })
    expect(onModelSettings).not.toHaveBeenCalled()
    expect(onOpenConversation).toHaveBeenCalledTimes(1)
})

test('a coworker scope change aborts the old search and never adopts its late result', async () => {
    const { root } = mount()
    let finishAda!: (response: Response) => void
    const fetcher = vi.fn(async (url: string) => {
        const params = new URL(url, 'http://local').searchParams
        if (params.get('agentId') === 'ada') return new Promise<Response>(resolve => { finishAda = resolve })
        return Response.json({ hits: [hit('bob-chat', 'bob', 'Bob', 'Scoped plan for Bob')], hasMore: false })
    })
    vi.stubGlobal('fetch', fetcher)
    await render(root)
    await press('f', { metaKey: true })
    await clickRow('Ada')
    await type('plan')
    await settle()
    await type('')
    await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })) })
    await clickRow('Bob')
    await type('plan')
    await settle()
    expect(new URL(fetcher.mock.calls.at(-1)![0], 'http://local').searchParams.get('agentId')).toBe('bob')
    expect(dialog()!.textContent).toContain('Scoped plan for Bob')
    await act(async () => { finishAda(Response.json({ hits: [hit('ada-chat', 'ada', 'Ada', 'Late plan for Ada')], hasMore: false })) })
    expect(dialog()!.textContent).not.toContain('Late plan for Ada')
    expect(dialog()!.textContent).toContain('Scoped plan for Bob')
})

test('shows the result limit honestly and uses Mac-specific copy in the unchanged original layout', async () => {
    const { root } = mount()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hits: [hit('ada-chat', 'ada', 'Ada', 'Plan')], hasMore: true })))
    await render(root)
    await press('f', { metaKey: true })
    expect(dialog()!.textContent).toContain('Jump to a coworker, model settings or a saved conversation.')
    expect(dialog()!.textContent).toContain('to close')
    expect(dialog()!.textContent).not.toContain('again to search in the page')
    expect(dialog()!.textContent).not.toContain('ask Rerun')
    await type('plan')
    await settle()
    expect(dialog()!.textContent).toContain('Showing the first 50 matches. Refine your search for more.')
})

test('dismissal restores the original composer focus, but disabling for another overlay does not', async () => {
    const { root } = mount()
    const composer = document.body.appendChild(document.createElement('textarea'))
    composer.value = 'Unsent draft'
    composer.focus()
    await render(root)
    await press('f', { metaKey: true })
    await press('Escape')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(composer)
    expect(composer.value).toBe('Unsent draft')
    await press('f', { metaKey: true })
    const focus = vi.spyOn(composer, 'focus')
    await render(root, { disabled: true })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(focus).not.toHaveBeenCalled()
})

test('a quit beginning before the disabled prop updates blocks retained commands and opening shortcuts', async () => {
    const { root } = mount()
    const onModelSettings = vi.fn()
    await render(root, { onModelSettings })
    await press('f', { metaKey: true })
    const select = rendered.view!.sections.flatMap(section => section.rows).find(row => row.id === 'command-model_settings')!.onSelect
    const drafts = await import('@/lib/desktop/draft-writes')
    vi.spyOn(drafts, 'isDesktopQuitting').mockReturnValue(true)
    await act(async () => { select() })
    expect(onModelSettings).not.toHaveBeenCalled()
    await render(root, { open: false })
    await press('f', { metaKey: true })
    expect(dialog()).toBeNull()
})

test('the shared view retains its original web description and footer when overrides are absent', async () => {
    const { root } = mount()
    const { ControlCenterView } = await import('@/components/control-center/ControlCenterView')
    await act(async () => {
        root.render(<ControlCenterView open onOpenChange={() => {}} query="" onQueryChange={() => {}}
            placeholder="Search" pageKey="root" depth={0} crumbs={[]} onBack={() => {}}
            sections={[]} emptyLabel="Nothing matches." mod="⌘" />)
    })
    expect(dialog()!.textContent).toContain('Jump to an agent, a setting or a conversation, or ask Rerun.')
    expect(dialog()!.textContent).toContain('again to search in the page')
    expect(dialog()!.textContent).not.toContain('Showing the first 50 matches.')
})

test('bootstrap Recent restores the original rows without a read or write and remounting does not duplicate a visit', async () => {
    const first = mount()
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
        const payload = JSON.parse(String(options?.body))
        return Response.json({ revision: payload.baseRevision + 1, recentAgentIds: ['ada', 'bob'] })
    })
    vi.stubGlobal('fetch', fetcher)
    const initialRecent = { revision: 7, recentAgentIds: ['bob', 'ada'] }
    await render(first.root, { initialRecent })
    await press('f', { metaKey: true })
    expect(rows()[0].textContent).toContain('Bob')
    expect(fetcher).not.toHaveBeenCalled()
    await press('f', { metaKey: true })
    await render(first.root, { initialRecent, selectedCoworkerId: 'ada' })
    await act(async () => { await flushDesktopRecentCoworkers() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ agentId: 'ada', baseRevision: 7, requestId: expect.any(String) })
    await act(async () => { first.root.unmount() })
    const second = mount()
    await render(second.root, { initialRecent, selectedCoworkerId: 'ada' })
    await press('f', { metaKey: true })
    expect(rows()[0].textContent).toContain('Ada')
    expect(fetcher).toHaveBeenCalledTimes(1)
})

test('a failed Recent save shows an original-style Retry row while coworker navigation stays available', async () => {
    const { root } = mount()
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Lost ACK'))
        .mockResolvedValueOnce(Response.json({ revision: 1, recentAgentIds: ['ada'] }))
    vi.stubGlobal('fetch', fetcher)
    const onOpenCoworker = vi.fn()
    await render(root, { onOpenCoworker })
    await render(root, { onOpenCoworker, selectedCoworkerId: 'ada' })
    await act(async () => { await flushDesktopRecentCoworkers() })
    await press('f', { metaKey: true })
    expect(dialog()!.textContent).toContain('Could not save recent coworkers.')
    expect(rows()[0].textContent).toContain('Ada')
    await clickRow('Ada')
    expect(onOpenCoworker).toHaveBeenCalledExactlyOnceWith('ada')
    await press('f', { metaKey: true })
    await clickRow('Could not save recent coworkers.')
    await act(async () => { await flushDesktopRecentCoworkers() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body)
    expect(dialog()!.textContent).not.toContain('Could not save recent coworkers.')
})

test('blank coworker drill lists actual open tabs and recent conversations and opens the exact unsent tab after verification', async () => {
    const { root } = mount()
    const blank = openChat('draft-tab', null)
    const saved = openChat('saved-tab', 'saved-session', 'Saved open chat')
    const response = chatList('ada', { openChats: [blank, saved], recentChats: [hit('recent-session', 'ada', 'Ada', 'Earlier discussion')], hasMore: true })
    const fetcher = vi.fn(async () => Response.json(response))
    vi.stubGlobal('fetch', fetcher)
    const onOpenChat = vi.fn(), onOpenConversation = vi.fn()
    await render(root, { onOpenChat, onOpenConversation })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    expect(dialog()!.textContent).toContain('Open chats')
    expect(dialog()!.textContent).toContain('Recent conversations')
    expect(rows().map(row => row.textContent)).toEqual(['New conversation', 'Saved open chat', 'Earlier discussion'])
    expect(dialog()!.textContent).toContain('Showing 8 recent conversations. Type to search older chats.')
    await clickRow('New conversation')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(blank)
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
})

test('a formerly blank tab that acquired a session is refreshed with an honest notice instead of opening the stale blank', async () => {
    const { root } = mount()
    const blank = openChat('draft-tab', null)
    const bound = openChat('draft-tab', 'new-session', 'Now a saved chat')
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(chatList('ada', { openChats: [++reads === 1 ? blank : bound] }))))
    const onOpenChat = vi.fn()
    await render(root, { onOpenChat })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    await clickRow('New conversation')
    expect(onOpenChat).not.toHaveBeenCalled()
    expect(dialog()!.textContent).toContain('This chat changed. Choose it again from the refreshed list.')
    expect(dialog()!.textContent).toContain('Now a saved chat')
    expect(dialog()!.textContent).not.toContain('New conversation')
    await clickRow('Now a saved chat')
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(bound)
})

test('a retained row and a late verification cannot navigate after the query or open cycle changes', async () => {
    const { root } = mount()
    const snapshot = chatList('ada', { openChats: [openChat('draft-tab', null)] })
    let finish!: (response: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot))
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const onOpenChat = vi.fn()
    await render(root, { onOpenChat })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    const select = rendered.view!.sections.flatMap(section => section.rows).find(row => row.id === 'open-chat-draft-tab')!.onSelect
    await act(async () => { select(); select() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await type('x')
    await act(async () => { select() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await press('f', { metaKey: true })
    await press('f', { metaKey: true })
    await act(async () => { finish(Response.json(snapshot)) })
    expect(onOpenChat).not.toHaveBeenCalled()
    expect(field().placeholder).toBe('Search coworkers, settings, conversations…')
})

test('recent-history unavailability keeps open tabs usable and Retry refreshes only the lists', async () => {
    const { root } = mount()
    const blank = openChat('draft-tab', null)
    let recovered = false
    const fetcher = vi.fn(async () => Response.json(chatList('ada', {
        openChats: [blank], recentStatus: recovered ? 'ok' : 'unavailable',
        recentChats: recovered ? [hit('recent', 'ada', 'Ada', 'Recovered discussion')] : [],
    })))
    vi.stubGlobal('fetch', fetcher)
    const onOpenChat = vi.fn()
    await render(root, { onOpenChat })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    expect(dialog()!.textContent).toContain('New conversation')
    expect(dialog()!.textContent).toContain('Could not load recent conversations')
    expect(dialog()!.textContent).not.toContain('No open chats or recent conversations yet.')
    await clickRow('New conversation')
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(blank)
    await press('f', { metaKey: true })
    await clickRow('Ada')
    recovered = true
    await clickRow('Could not load recent conversations')
    expect(dialog()!.textContent).toContain('Recovered discussion')
    expect(dialog()!.textContent).not.toContain('Could not load recent conversations')
})

test('a recent conversation that became open uses the existing exact tab instead of creating another', async () => {
    const { root } = mount()
    const recent = hit('session-a', 'ada', 'Ada', 'Same title')
    const existing = openChat('existing-tab', 'session-a', 'Same title')
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(++reads === 1
        ? chatList('ada', { recentChats: [recent] }) : chatList('ada', { openChats: [existing] }))))
    const onOpenChat = vi.fn(), onOpenConversation = vi.fn()
    await render(root, { onOpenChat, onOpenConversation })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    await clickRow('Same title')
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(existing)
    expect(onOpenConversation).not.toHaveBeenCalled()
})

test('full chat-list failure is retryable rather than empty, and deleted owners cannot be opened by retained rows', async () => {
    const { root } = mount()
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 }))
        .mockImplementation(async () => Response.json(chatList('ada', { openChats: [openChat('draft-tab', null)] })))
    vi.stubGlobal('fetch', fetcher)
    const onOpenChat = vi.fn()
    await render(root, { onOpenChat })
    await press('f', { metaKey: true })
    await clickRow('Ada')
    expect(dialog()!.textContent).toContain('Could not load chats')
    expect(dialog()!.textContent).not.toContain('No open chats or recent conversations yet.')
    await clickRow('Could not load chats')
    const select = rendered.view!.sections.flatMap(section => section.rows).find(row => row.id === 'open-chat-draft-tab')!.onSelect
    await render(root, { onOpenChat, coworkers: [coworker('bob', 'Bob')] })
    await act(async () => { select() })
    expect(onOpenChat).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
})
