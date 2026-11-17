// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopSidebarDrop, DesktopSidebarList } from '@/lib/desktop/workspace-view'
import type { DesktopAgentView } from '../DesktopApp'
import { DesktopSimpleSidebar } from './DesktopSimpleSidebar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@rerun/ui/foreman', () => ({ Orb: () => null }))
vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: ({ mood }: { mood: string }) => <span data-mood={mood} /> }))
// The real drag engine needs a laid-out page. Its events are handed to the list as it would hand them.
type Handlers = { onDragStart(event: unknown): void; onDragOver(event: unknown): void; onDragEnd(event: unknown): void; onDragCancel(): void }
let drag: Handlers
vi.mock('@dnd-kit/core', async original => {
    const actual = await original<typeof import('@dnd-kit/core')>()
    return { ...actual,
        DndContext: (props: Handlers & { children: ReactNode }) => { drag = props; return <actual.DndContext {...(props as object)} /> },
        DragOverlay: ({ children }: { children: ReactNode }) => <div data-overlay>{children}</div> }
})

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = '' })
const agent = (id: string, at: string, patch: Partial<DesktopAgentView> = {}): DesktopAgentView => ({ id, name: id, description: '', createdAt: at, updatedAt: '', ...patch })
const BOXES = [{ id: 'sales', name: 'Sales' }, { id: 'support', name: 'Support' }, { id: 'lab', name: 'Lab' }]
const HOME: Record<string, string> = { ann: 'sales', bo: 'sales', cy: 'sales', di: 'support' }
const AGENTS = [agent('ann', '1'), agent('bo', '2'), agent('cy', '3', { enabled: false }), agent('di', '4')]

function mount(props: { onArrange?: (drop: DesktopSidebarDrop) => void; onMoveToBox?: (agentId: string, boxId: string) => void; order?: Pick<DesktopSidebarList, 'boxes' | 'agents'>; disabled?: boolean; collapsed?: string[] }) {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(<DesktopSimpleSidebar workspaceMenu={null} selectedId={null} foremanOpen={false} onOpenCoworker={vi.fn()} onNewCoworker={vi.fn()} onOpenCard={vi.fn()}
        agents={AGENTS} statuses={{}} previews={{}} boxes={BOXES} boxOf={id => HOME[id] ?? null} {...props} />) })
    return host
}
const tiles = (host: HTMLElement, box: string) => [...host.querySelectorAll<HTMLElement>(`section[data-simple-box-id="${box}"] [data-simple-tile-id]`)].map(tile => tile.dataset.simpleTileId)
const drop = (activeId: string, overId: string | null) => act(() => { drag.onDragEnd({ active: { id: activeId }, over: overId ? { id: overId } : null }) })

test('a coworker dragged onto another takes its place in its Box, and the saved order is what the list then shows', () => {
    const onArrange = vi.fn<(drop: DesktopSidebarDrop) => void>()
    const host = mount({ onArrange, onMoveToBox: vi.fn() })
    expect(tiles(host, 'sales')).toEqual(['ann', 'bo', 'cy'])
    drop('agent:cy', 'agent:ann')
    // Nobody had arranged this Box: it is numbered in the order shown, Cy first.
    expect(onArrange).toHaveBeenCalledExactlyOnceWith({ kind: 'agents', boxId: 'sales', writes: [{ id: 'cy', order: 1 }, { id: 'ann', order: 2 }, { id: 'bo', order: 3 }] })
    const order = { boxes: {}, agents: { cy: { box: 'sales', rank: 1 }, ann: { box: 'sales', rank: 2 }, bo: { box: 'sales', rank: 3 } } }
    const arranged = mount({ onArrange, onMoveToBox: vi.fn(), order })
    expect(tiles(arranged, 'sales')).toEqual(['cy', 'ann', 'bo'])
    // Once arranged, a move writes one rank, halfway between its neighbours.
    drop('agent:bo', 'agent:ann')
    expect(onArrange).toHaveBeenLastCalledWith({ kind: 'agents', boxId: 'sales', writes: [{ id: 'bo', order: 1.5 }] })
    // Dropped where it already is, on the name of its own Box, or nowhere: nothing is asked.
    onArrange.mockClear()
    drop('agent:bo', 'agent:bo'); drop('agent:bo', 'drop:sales'); drop('agent:bo', null)
    expect(onArrange).not.toHaveBeenCalled()
})

test('a coworker lands in another Box before the coworker it is dropped on, or at the end of an empty or folded one', () => {
    const onArrange = vi.fn<(drop: DesktopSidebarDrop) => void>()
    const host = mount({ onArrange, onMoveToBox: vi.fn(), collapsed: ['lab'] })
    act(() => { drag.onDragStart({ active: { id: 'agent:ann' } }) })
    // What follows the pointer is the coworker as the list reads it.
    expect(host.querySelector('[data-overlay] [data-simple-drag-ghost="agent"]')?.textContent).toBe('ann')
    act(() => { drag.onDragOver({ over: { id: 'agent:di' } }) })
    // The Box it would land in stays lit and a line marks the tile it lands before.
    const support = host.querySelector<HTMLElement>('section[data-simple-box-id="support"]')!
    expect(support.className).toContain('ring-1')
    expect(host.querySelector('[data-simple-sortable-tile="di"] [data-simple-landing-line]')).not.toBeNull()
    expect(host.querySelector<HTMLElement>('section[data-simple-box-id="sales"]')!.className).not.toContain('ring-1')
    drop('agent:ann', 'agent:di')
    expect(onArrange).toHaveBeenCalledExactlyOnceWith({ kind: 'move', agentId: 'ann', boxId: 'support', writes: [{ id: 'ann', order: 1 }, { id: 'di', order: 2 }] })
    expect(support.className).not.toContain('ring-1')
    expect(host.querySelector('[data-simple-landing-line]')).toBeNull()
    // A folded, empty Box takes it too.
    drop('agent:ann', 'drop:lab')
    expect(onArrange).toHaveBeenLastCalledWith({ kind: 'move', agentId: 'ann', boxId: 'lab', writes: [{ id: 'ann', order: 1 }] })
    drop('agent:ann', 'drop:support')
    expect(onArrange).toHaveBeenLastCalledWith({ kind: 'move', agentId: 'ann', boxId: 'support', writes: [{ id: 'di', order: 1 }, { id: 'ann', order: 2 }] })
})

test('a Box dragged by its name takes its place among the others', () => {
    const onArrange = vi.fn<(drop: DesktopSidebarDrop) => void>()
    const host = mount({ onArrange, order: { boxes: { lab: 1, sales: 2, support: 3 }, agents: {} } })
    expect([...host.querySelectorAll<HTMLElement>('section[data-simple-box-id]')].map(section => section.dataset.simpleBoxId)).toEqual(['lab', 'sales', 'support'])
    act(() => { drag.onDragStart({ active: { id: 'box:support' } }) })
    expect(host.querySelector('[data-overlay] [data-simple-drag-ghost="box"]')?.textContent).toBe('Support1')
    drop('box:support', 'box:lab')
    expect(onArrange).toHaveBeenCalledExactlyOnceWith({ kind: 'boxes', writes: [{ id: 'support', order: 0 }] })
    drop('box:support', 'box:sales')
    expect(onArrange).toHaveBeenLastCalledWith({ kind: 'boxes', writes: [{ id: 'support', order: 1.5 }] })
    drop('box:support', 'box:support')
    expect(onArrange).toHaveBeenCalledTimes(2)
})

test('the keyboard picks an item up from the item itself, and nothing is picked up while the list only reads', () => {
    const onArrange = vi.fn<(drop: DesktopSidebarDrop) => void>()
    const host = mount({ onArrange, onMoveToBox: vi.fn() })
    // The tile's wrapper and the Box's header are the handles: the buttons inside keep Enter and their click.
    const wrapper = host.querySelector<HTMLElement>('[data-simple-sortable-tile="ann"]')!
    expect(wrapper.getAttribute('role')).toBe('group')
    expect(wrapper.getAttribute('tabindex')).toBe('0')
    expect(wrapper.querySelector('button[data-simple-tile-id="ann"]')).not.toBeNull()
    const header = host.querySelector<HTMLElement>('section[data-simple-box-id="sales"] [data-simple-box-toggle]')!.parentElement!
    expect(header.getAttribute('role')).toBe('group')
    // Without a move to another Box (the board cannot be reached) a coworker only moves inside its Box.
    const inside = mount({ onArrange })
    act(() => { drag.onDragStart({ active: { id: 'agent:ann' } }); drag.onDragOver({ over: { id: 'agent:di' } }) })
    expect(inside.querySelector('[data-simple-landing-line]')).toBeNull()
    drop('agent:ann', 'agent:di')
    expect(onArrange).not.toHaveBeenCalled()
    for (const still of [mount({}), mount({ onArrange, disabled: true })]) {
        expect(still.querySelector('[data-simple-sortable-tile="ann"]')!.hasAttribute('tabindex')).toBe(false)
        expect(still.querySelector<HTMLElement>('section[data-simple-box-id="sales"] [data-simple-box-toggle]')!.parentElement!.hasAttribute('role')).toBe(false)
        drop('agent:cy', 'agent:ann')
    }
    expect(onArrange).not.toHaveBeenCalled()
    expect(tiles(host, 'sales')).toEqual(['ann', 'bo', 'cy'])
})
