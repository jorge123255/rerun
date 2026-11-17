// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopAgentView } from '../DesktopApp'
import { DesktopSimpleSidebar } from './DesktopSimpleSidebar'
import { DesktopViewMenuRow } from './DesktopViewMenuRow'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@rerun/ui/foreman', () => ({ Orb: () => null }))
vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: ({ mood }: { mood: string }) => <span data-mood={mood} /> }))

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = '' })
function mount(node: React.ReactNode) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(node) })
    return host
}
const agent = (id: string, name: string, patch: Partial<DesktopAgentView> = {}): DesktopAgentView => ({ id, name, description: 'Finds leads', createdAt: '', updatedAt: '', ...patch })

test('lists coworkers most recently active first, each keeping its line at rest with a dot for where it stands', async () => {
    const onOpen = vi.fn(), onForeman = vi.fn(), onSearch = vi.fn(), onNew = vi.fn()
    const host = mount(<DesktopSimpleSidebar workspaceMenu={<span>menu</span>} selectedId="bo" foremanOpen={false}
        agents={[agent('ann', 'Ann'), agent('bo', 'Bo'), agent('cy', 'Cy', { enabled: false }), agent('di', 'Di'), agent('ed', 'Ed', { description: '' })]}
        statuses={{ ann: 'working', bo: 'waiting_human', cy: 'working', di: 'unreachable', ed: 'idle' }}
        previews={{ ann: { title: 'Q4 prospects', updatedAt: '2026-11-13T10:00:00.000Z' }, bo: { title: 'Approve the invoice', updatedAt: '2026-11-13T12:00:00.000Z' }, di: { title: 'Weekly report', updatedAt: '2026-11-12T10:00:00.000Z', lastMessage: { text: 'Send it on Monday', mine: true } } }}
        unseenIds={['bo', 'ann', 'di']} onOpenCoworker={onOpen} onOpenForeman={onForeman} onSearch={onSearch} onNewCoworker={onNew} />)
    const tiles = [...host.querySelectorAll<HTMLButtonElement>('[data-simple-tile-id]')]
    expect(tiles.map(tile => tile.dataset.simpleTileId)).toEqual(['bo', 'ann', 'di', 'cy', 'ed'])
    const lines = tiles.map(tile => tile.querySelector('[data-tile-line]'))
    // Each line reads as it does at rest, whatever the coworker is doing (upstream #278).
    expect(lines.map(line => line?.textContent)).toEqual(['Approve the invoice', 'Q4 prospects', 'You: Send it on Monday', 'Finds leads', ' '])
    expect(lines.every(line => line?.className.includes('text-muted-foreground') && !line.className.includes('orange'))).toBe(true)
    // The dot alone tells where each stands: waiting, working, a run nobody opened, paused, nothing at rest.
    const dots = tiles.map(tile => tile.querySelector<HTMLElement>('[data-tile-dot]'))
    expect(dots.map(dot => dot?.dataset.tileDot ?? null)).toEqual(['waiting', 'working', 'unseen', 'paused', null])
    expect(dots.map(dot => dot?.getAttribute('aria-label') ?? null)).toEqual(['Waiting for you', 'Working', null, 'Paused', null])
    expect(dots[0]!.querySelector('.bg-orange-400')).not.toBeNull()
    // Working is green and pulses; a read that failed (Di) is never shown as an error or as work.
    expect(dots[1]!.querySelector('.bg-emerald-500')).not.toBeNull()
    expect(dots[1]!.querySelector('.animate-ping')).not.toBeNull()
    expect(dots[2]!.className).toContain('bg-brand')
    expect(dots[3]!.querySelector('.bg-muted-foreground\\/40')).not.toBeNull()
    // The buddy keeps its look at rest: asleep only when paused.
    expect(tiles.map(tile => tile.querySelector('[data-mood]')?.getAttribute('data-mood'))).toEqual(['idle', 'idle', 'idle', 'asleep', 'idle'])
    expect(tiles[0].getAttribute('aria-current')).toBe('true')
    expect(tiles[1].getAttribute('aria-current')).toBeNull()
    await act(async () => { tiles[1].click() })
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('ann')
    const named = (name: string) => [...host.querySelectorAll('button')].find(button => button.textContent?.includes(name))!
    await act(async () => { named('Chief of Staff').click(); named('Search').click(); host.querySelector<HTMLButtonElement>('button[aria-label="New coworker"]')?.click() })
    expect(onForeman).toHaveBeenCalledOnce()
    expect(onSearch).toHaveBeenCalledOnce()
    expect(onNew).toHaveBeenCalledOnce()
})

test('an empty workspace offers a first coworker, and the view row switches between the board and Simple', async () => {
    const onNew = vi.fn(), onChange = vi.fn()
    const host = mount(<>
        <DesktopSimpleSidebar workspaceMenu={null} agents={[]} statuses={{}} previews={{}} selectedId={null} foremanOpen={false} onOpenCoworker={vi.fn()} onNewCoworker={onNew} />
        <DesktopViewMenuRow view="board" onChange={onChange} />
    </>)
    expect(host.textContent).toContain('No coworkers yet')
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios.map(radio => [radio.getAttribute('aria-label'), radio.getAttribute('aria-checked')])).toEqual([['3D', 'true'], ['Simple', 'false']])
    await act(async () => { radios[1].click() })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('simple')
})

test('the tile menu opens the card, places a copy and moves a coworker to another Box', async () => {
    const onCard = vi.fn(), onDuplicate = vi.fn(), onMove = vi.fn()
    const host = mount(<DesktopSimpleSidebar workspaceMenu={null} agents={[agent('ann', 'Ann')]} statuses={{}} previews={{}} selectedId={null} foremanOpen={false}
        onOpenCoworker={vi.fn()} onNewCoworker={vi.fn()} onOpenCard={onCard} onDuplicate={onDuplicate} onMoveToBox={onMove}
        boxes={[{ id: 'sales', name: 'Sales' }, { id: 'support', name: 'Support' }]} boxOf={() => 'sales'} />)
    const open = async () => {
        const more = host.querySelector<HTMLButtonElement>('button[aria-label="More for Ann"]')!
        more.focus()
        await act(async () => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
        return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    }
    const items = await open()
    expect(items.map(item => item.textContent)).toEqual(['Coworker card', 'Duplicate', 'Move to Box'])
    await act(async () => { items[1].click() })
    expect(onDuplicate).toHaveBeenCalledExactlyOnceWith('ann')
    const again = await open()
    await act(async () => { again[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 5)) })
    // Only the other Box is offered.
    const boxes = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item => !['Coworker card', 'Duplicate', 'Move to Box'].includes(item.textContent ?? ''))
    expect(boxes.map(item => item.textContent)).toEqual(['Support'])
    await act(async () => { boxes[0].click() })
    expect(onMove).toHaveBeenCalledExactlyOnceWith('ann', 'support')
    expect(onCard).not.toHaveBeenCalled()
})
