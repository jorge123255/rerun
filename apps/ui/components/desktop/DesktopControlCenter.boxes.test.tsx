// @vitest-environment happy-dom
// Root runs all checks. Keep the original command view and inspect its retained row callbacks.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ControlRow } from '@/components/control-center/types'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import * as draftWrites from '@/lib/desktop/draft-writes'
import { DesktopControlCenter, type DesktopControlCenterProps } from './DesktopControlCenter'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const coworkers = [
    { id: 'ada', name: 'Ada', description: 'Research', createdAt: '', updatedAt: '', spaceId: 'wrong-old-membership' },
    { id: 'bob', name: 'Bob', description: '', createdAt: '', updatedAt: '', enabled: false },
]
const board = (): DesktopBoardState => ({ revision: 7, spaces: [
    { id: 'review', name: 'Review team', col_start: 0, row_start: 0, col_end: 3, row_end: 3 },
    { id: 'project', name: 'Project team', col_start: 6, row_start: 0, col_end: 9, row_end: 3 },
    { id: 'empty', name: 'Empty team', col_start: 12, row_start: 0, col_end: 15, row_end: 3 },
], placements: [{ agentId: 'ada', spaceId: 'review', col: 0, row: 0 }, { agentId: 'bob', spaceId: 'project', col: 6, row: 0 }] })
const roots = new Set<Root>()
const requests: string[] = []
const view = () => rendered.view!
const rows = () => view().sections.flatMap(section => section.rows)
const row = (id: string): ControlRow => {
    const found = rows().find(entry => entry.id === id)
    expect(found, id).toBeDefined()
    return found!
}
const select = (entry: ControlRow) => act(async () => { entry.onSelect() })
const query = (value: string) => act(async () => { view().onQueryChange(value) })
const press = (key: string) => act(async () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
})
async function fixture(overrides: Partial<DesktopControlCenterProps> = {}) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.add(root)
    let props: DesktopControlCenterProps = {
        open: true, initialRecent: { revision: 0, recentAgentIds: [] }, coworkers, board: board(), selectedCoworkerId: null,
        onOpenChange: vi.fn(), onOpenCoworker: vi.fn(), onOpenConversation: vi.fn(), onAddBox: vi.fn(), onMoveCoworker: vi.fn(),
        onAddCoworker: vi.fn(), onModelSettings: vi.fn(), onBackToBoard: vi.fn(), ...overrides,
    }
    const update = async (patch: Partial<DesktopControlCenterProps> = {}) => {
        props = { ...props, ...patch }
        await act(async () => { root.render(<DesktopControlCenter {...props} />) })
    }
    await update()
    return { update, props: () => props }
}
async function openBox(id = 'review') {
    await query(id === 'review' ? 'Review' : id === 'empty' ? 'Empty' : 'Project')
    const item = document.querySelector<HTMLElement>(`[cmdk-item][data-value="box-${id}"]`)
    expect(item).not.toBeNull()
    await act(async () => { item!.click() })
}
async function openMove() {
    await act(async () => { row('coworkers-coworker-ada').onDrill!() })
    await select(row('coworker-move'))
}

beforeEach(() => {
    resetDesktopRecentCoworkers()
    requests.length = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        requests.push(url)
        if (url.startsWith('/api/desktop/conversations/search')) return Response.json({ hits: [], hasMore: false })
        const match = url.match(/^\/api\/desktop\/agents\/([^/]+)\/control-center-chats$/)
        if (match) return Response.json({ agentId: match[1], openChats: [], recentChats: [], recentStatus: 'ok', hasMore: false })
        throw new Error(`Unexpected request ${url}`)
    }))
})
afterEach(async () => {
    for (const root of roots) await act(async () => { root.unmount() })
    roots.clear()
    resetDesktopRecentCoworkers()
    document.body.innerHTML = ''
    rendered.view = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('Box search follows original scope and five-result limit, using durable membership for counts and coworker detail', async () => {
    const many = board()
    many.spaces.push(...Array.from({ length: 5 }, (_, i) => ({ id: `extra-${i}`, name: `Extra team ${i}`, col_start: 20 + i * 6, row_start: 0, col_end: 23 + i * 6, row_end: 3 })))
    await fixture({ board: many })
    expect(view().sections.some(section => section.id === 'boxes')).toBe(false)
    expect(row('coworkers-coworker-ada').detail).toBe('Review team')
    await query('team')
    expect(view().sections.find(section => section.id === 'boxes')?.rows).toHaveLength(5)
    await query('Review')
    expect(row('box-review').detail).toBe('1 coworker')
    expect(row('coworkers-coworker-ada').detail).toBe('Review team')
    await query('@Review')
    expect(view().sections.map(section => section.id)).toEqual(['coworkers'])
    await query('/Review')
    expect(view().sections.some(section => section.id === 'boxes')).toBe(false)
})

test('Box rows drill in the original view; Tab and Back traverse members without changing the selected chat', async () => {
    const ui = await fixture()
    await openBox()
    expect(view().pageKey).toBe('box:review')
    expect(view().crumbs).toEqual(['Review team'])
    expect(view().query).toBe('')
    expect(rows().map(entry => entry.id)).toEqual(['box-coworker-ada'])
    await press('Tab')
    expect(view().pageKey).toBe('coworker:ada')
    await press('ArrowLeft')
    expect(view().pageKey).toBe('box:review')
    await press('Backspace')
    expect(view().pageKey).toBe('root')
    expect(ui.props().onOpenCoworker).not.toHaveBeenCalled()
    expect(ui.props().onOpenChange).not.toHaveBeenCalled()
})

test('empty Box wording and prefixed Box/move searches stay local and never fetch saved conversations', async () => {
    await fixture()
    await openBox('empty')
    expect(view().emptyLabel).toBe('No coworkers in this Box yet.')
    await query('/Settings')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(rows()).toEqual([])
    expect(requests.filter(url => url.includes('/conversations/search'))).toEqual([])
    await act(async () => { view().onBack() })
    await openMove()
    requests.length = 0
    await query('@Project')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(rows().map(entry => entry.id)).toEqual(['move-project'])
    expect(requests).toEqual([])
})

test('Move excludes the current Box, disables full destinations, and dispatches one move without a position', async () => {
    const full = board()
    full.placements.push(...[[12, 0], [14, 0], [12, 2], [14, 2]].map(([col, row], i) => ({ agentId: `occupant-${i}`, spaceId: 'empty', col, row })))
    const ui = await fixture({ board: full })
    await openMove()
    expect(view().crumbs).toEqual(['Ada', 'Move to another Box'])
    expect(rows().map(entry => entry.id)).toEqual(['move-project', 'move-empty'])
    expect(row('move-empty').disabledReason).toContain('no free spot')
    await select(row('move-empty'))
    expect(ui.props().onMoveCoworker).not.toHaveBeenCalled()
    const destination = row('move-project')
    await select(destination)
    await select(destination)
    expect(ui.props().onMoveCoworker).toHaveBeenCalledExactlyOnceWith('ada', 'project')
    expect(ui.props().onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})

test.each(['revision', 'membership', 'removed destination', 'full destination', 'removed owner', 'removed callback', 'close/reopen', 'query', 'Quit'] as const)
('a retained move cannot run after %s changes', async cause => {
    const ui = await fixture()
    const move = ui.props().onMoveCoworker
    const close = ui.props().onOpenChange
    await openMove()
    const retained = row('move-project')
    const next = board()
    if (cause === 'revision') { next.revision++; await ui.update({ board: next }) }
    if (cause === 'membership') { next.placements[0].spaceId = 'empty'; await ui.update({ board: next }) }
    if (cause === 'removed destination') { next.spaces = next.spaces.filter(space => space.id !== 'project'); await ui.update({ board: next }) }
    if (cause === 'full destination') {
        next.placements.push(...[[8, 0], [6, 2], [8, 2]].map(([col, row], i) => ({ agentId: `occupant-${i}`, spaceId: 'project', col, row })))
        await ui.update({ board: next })
    }
    if (cause === 'removed owner') await ui.update({ coworkers: coworkers.filter(owner => owner.id !== 'ada') })
    if (cause === 'removed callback') await ui.update({ onMoveCoworker: undefined })
    if (cause === 'close/reopen') { await ui.update({ open: false }); await ui.update({ open: true }) }
    if (cause === 'query') await query('Project')
    if (cause === 'Quit') vi.spyOn(draftWrites, 'isDesktopQuitting').mockReturnValue(true)
    await select(retained)
    expect(move).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
})

test.each(['membership', 'revision', 'removed Box'] as const)('retained Box member selection and drilling reject %s changes', async cause => {
    const ui = await fixture()
    await openBox()
    const retained = row('box-coworker-ada')
    const next = board()
    if (cause === 'membership') next.placements[0].spaceId = 'project'
    if (cause === 'revision') next.revision++
    if (cause === 'removed Box') next.spaces = next.spaces.filter(space => space.id !== 'review')
    await ui.update({ board: next })
    await select(retained)
    await act(async () => { retained.onDrill!() })
    expect(ui.props().onOpenCoworker).not.toHaveBeenCalled()
    expect(ui.props().onOpenChange).not.toHaveBeenCalled()
    expect(view().pageKey).toBe('box:review')
})

test('New Box needs a live callback and works with zero Boxes; unsupported controls remain absent', async () => {
    const ui = await fixture({ board: { revision: 8, spaces: [], placements: [] } })
    const retained = row('command-new_box')
    const add = ui.props().onAddBox
    await ui.update({ onAddBox: undefined })
    expect(rows().some(entry => entry.id === 'command-new_box')).toBe(false)
    await select(retained)
    expect(add).not.toHaveBeenCalled()
    await ui.update({ onAddBox: add })
    await select(row('command-new_box'))
    expect(add).toHaveBeenCalledOnce()
    expect(ui.props().onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})

test('without board wiring, existing coworker controls remain usable and no Box commands are offered', async () => {
    await fixture({ board: undefined, onAddBox: undefined, onMoveCoworker: undefined })
    expect(row('coworkers-coworker-ada').detail).toBe('Research')
    expect(rows().some(entry => entry.id === 'command-new_box')).toBe(false)
    await act(async () => { row('coworkers-coworker-ada').onDrill!() })
    expect(rows().some(entry => entry.id === 'coworker-move')).toBe(false)
})
