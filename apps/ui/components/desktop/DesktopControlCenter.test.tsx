// @vitest-environment happy-dom
// Authored for the control-center lane; the integration owner runs all validation.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import { DesktopControlCenter } from './DesktopControlCenter'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = (id: string, name = id, description = '', enabled?: boolean) =>
    ({ id, name, description, createdAt: '', updatedAt: '', ...(enabled === undefined ? {} : { enabled }) })
const hit = (id: string, agentId: string, agentName: string, title: string): DesktopConversationHit =>
    ({ id, agentId, agentName, title })

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
    coworkers?: Parameters<typeof DesktopControlCenter>[0]['coworkers']
    selectedCoworkerId?: string | null
    onOpenConversation?: (hit: DesktopConversationHit) => void
    onAddCoworker?: () => void
    onModelSettings?: () => void
    onBackToBoard?: () => void
}

function mount() {
    const container = document.createElement('div')
    document.body.append(container)
    return { container, root: createRoot(container) }
}

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

const render = (root: ReturnType<typeof createRoot>, overrides: Overrides = {}) => act(async () => {
    root.render(<DesktopControlCenter
        coworkers={overrides.coworkers ?? [coworker('ada', 'Ada', 'Files summaries'), coworker('bob', 'Bob'), coworker('cy', 'Cy', '', false)]}
        selectedCoworkerId={overrides.selectedCoworkerId ?? null}
        onOpenConversation={overrides.onOpenConversation ?? (() => {})}
        onAddCoworker={overrides.onAddCoworker ?? (() => {})}
        onModelSettings={overrides.onModelSettings ?? (() => {})}
        onBackToBoard={overrides.onBackToBoard ?? (() => {})} />)
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
        await render(root, { selectedCoworkerId: 'ada', ...actions })
        await press('f', { metaKey: true })
        expect(dialog()!.textContent).toContain('Recent')
        expect(rows()[0]!.textContent).toContain('Ada')
        expect(dialog()!.textContent).toContain('Actions')
        expect(dialog()!.textContent).toContain('Settings')
        for (const absent of ['Billing', 'Browse templates', 'Ask Rerun', 'Shared files', 'Contact Support', 'What’s new', 'Company Brain']) {
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
    const fetcher = vi.fn()
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finishStale = resolve }))
        .mockImplementation(async (url: string) => {
            const query = new URL(url, 'http://local').searchParams.get('q')
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

test('Enter drills into a coworker, the page scopes results to that coworker, and Backspace returns', async () => {
    const { root } = mount()
    const onOpenConversation = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const query = new URL(url, 'http://local').searchParams.get('q')
        if (query === 'plan') return Response.json({ hits: [hit('ada-1', 'ada', 'Ada', 'Shared plan'), hit('bob-1', 'bob', 'Bob', 'Shared plan')], hasMore: false })
        return Response.json({ hits: [], hasMore: false })
    }))
    try {
        await render(root, { onOpenConversation })
        await press('f', { metaKey: true })
        await clickRow('Ada')
        expect(field().getAttribute('placeholder')).toBe('Search in Ada…')
        expect(dialog()!.textContent).toContain('Type at least 2 characters to search this coworker’s saved chats.')
        await type('plan')
        await settle()
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
