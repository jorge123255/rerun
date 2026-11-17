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
        agents={[agent('ann', 'Ann'), agent('bo', 'Bo'), agent('cy', 'Cy', { enabled: false }), agent('di', 'Di'), agent('ed', 'Ed', { description: '' }), agent('fay', 'Fay', { enabled: false })]}
        statuses={{ ann: 'working', bo: 'waiting_human', cy: 'working', di: 'unreachable', ed: 'idle', fay: 'idle' }}
        previews={{ ann: { title: 'Q4 prospects', updatedAt: '2026-11-13T10:00:00.000Z' }, bo: { title: 'Approve the invoice', updatedAt: '2026-11-13T12:00:00.000Z' }, di: { title: 'Weekly report', updatedAt: '2026-11-12T10:00:00.000Z', lastMessage: { text: 'Send it on Monday', mine: true } } }}
        unseenIds={['bo', 'ann', 'di', 'fay']} onOpenCoworker={onOpen} onOpenForeman={onForeman} onSearch={onSearch} onNewCoworker={onNew} />)
    const tiles = [...host.querySelectorAll<HTMLButtonElement>('[data-simple-tile-id]')]
    expect(tiles.map(tile => tile.dataset.simpleTileId)).toEqual(['bo', 'ann', 'di', 'cy', 'ed', 'fay'])
    const lines = tiles.map(tile => tile.querySelector('[data-tile-line]'))
    // Each line reads as it does at rest, whatever the coworker is doing (upstream #278).
    expect(lines.map(line => line?.textContent)).toEqual(['Approve the invoice', 'Q4 prospects', 'You: Send it on Monday', 'Finds leads', ' ', 'Finds leads'])
    expect(lines.every(line => line?.className.includes('text-muted-foreground') && !line.className.includes('orange'))).toBe(true)
    // The dot alone tells where each stands: waiting, working, a run nobody opened, paused, nothing at rest.
    const dots = tiles.map(tile => tile.querySelector<HTMLElement>('[data-tile-dot]'))
    expect(dots.map(dot => dot?.dataset.tileDot ?? null)).toEqual(['waiting', 'working', 'unseen', 'paused', null, 'unseen'])
    expect(dots.map(dot => dot?.getAttribute('aria-label') ?? null)).toEqual(['Waiting for you', 'Working', null, 'Paused', null, null])
    expect(dots[0]!.querySelector('.bg-orange-400')).not.toBeNull()
    // Working is green and pulses; a read that failed (Di) is never shown as an error or as work.
    expect(dots[1]!.querySelector('.bg-emerald-500')).not.toBeNull()
    expect(dots[1]!.querySelector('.animate-ping')).not.toBeNull()
    expect(dots[2]!.className).toContain('bg-brand')
    expect(dots[3]!.querySelector('.bg-muted-foreground\\/40')).not.toBeNull()
    // A result nobody opened shows in front of the grey dot of a paused coworker (upstream #283); work and waiting keep theirs.
    expect(dots[5]!.className).toContain('bg-brand')
    // The buddy keeps its look at rest: asleep only when paused.
    expect(tiles.map(tile => tile.querySelector('[data-mood]')?.getAttribute('data-mood'))).toEqual(['idle', 'idle', 'idle', 'asleep', 'idle', 'asleep'])
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

const BOXES = [{ id: 'sales', name: 'Sales' }, { id: 'support', name: 'Support' }, { id: 'lab', name: 'Lab' }]
const HOME: Record<string, string> = { ann: 'support', bo: 'sales', cy: 'sales' }
const made = (id: string, name: string, at: string, patch: Partial<DesktopAgentView> = {}) => agent(id, name, { createdAt: at, ...patch })

test('lists the coworkers by Box under the Chief of Staff, an empty Box too, each in the order it was made', async () => {
    const host = mount(<DesktopSimpleSidebar workspaceMenu={null} selectedId="cy" foremanOpen onOpenForeman={vi.fn()} onOpenCoworker={vi.fn()} onNewCoworker={vi.fn()}
        agents={[made('cy', 'Cy', '2026-11-03'), made('ann', 'Ann', '2026-11-02'), made('bo', 'Bo', '2026-11-01'), made('di', 'Di', '2026-11-04')]}
        statuses={{}} previews={{ cy: { title: 'Newest', updatedAt: '2026-11-13T12:00:00.000Z' } }} boxes={BOXES} boxOf={id => HOME[id] ?? null} />)
    const list = host.querySelector('[data-testid="desktop-simple-list"]')!
    // The Chief of Staff stays on top, then the Boxes in the board's order: recency no longer orders the list.
    const rows = [...list.querySelectorAll<HTMLElement>('button[aria-current], [data-simple-box-toggle], [data-simple-tile-id], [data-simple-box-empty]')]
    expect(rows[0].textContent).toContain('Chief of Staff')
    expect(rows[0].getAttribute('aria-current')).toBe('true')
    const sections = [...list.querySelectorAll<HTMLElement>('section[data-simple-box-id]')]
    expect(sections.map(section => [section.getAttribute('aria-label'), section.querySelector('[data-simple-box-count]')?.textContent,
        [...section.querySelectorAll<HTMLElement>('[data-simple-tile-id]')].map(tile => tile.dataset.simpleTileId)])).toEqual([
        ['Sales', '2', ['bo', 'cy']],
        ['Support', '1', ['ann']],
        ['Lab', '0', []],
    ])
    expect(sections[2].querySelector('[data-simple-box-empty]')?.textContent).toBe('No coworkers')
    // A coworker the board has in no Box is not lost: it follows the Boxes.
    expect([...list.querySelectorAll<HTMLElement>('[data-simple-loose] [data-simple-tile-id]')].map(tile => tile.dataset.simpleTileId)).toEqual(['di'])
    expect(list.querySelector('[data-simple-tile-id="cy"]')?.getAttribute('aria-current')).toBe('true')
})

test('a Box folds away, says so, and shows an orange dot folded when one of its coworkers waits', async () => {
    const onToggle = vi.fn()
    const render = (collapsed: string[]) => <DesktopSimpleSidebar workspaceMenu={null} selectedId={null} foremanOpen={false} onOpenCoworker={vi.fn()} onNewCoworker={vi.fn()}
        agents={[made('ann', 'Ann', '1'), made('bo', 'Bo', '2'), made('cy', 'Cy', '3', { enabled: false })]} statuses={{ bo: 'waiting_human', cy: 'waiting_human' }} previews={{}}
        boxes={BOXES} boxOf={id => HOME[id] ?? null} collapsed={collapsed} onToggleBox={onToggle} />
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(render([])) })
    const toggle = (id: string) => host.querySelector<HTMLButtonElement>(`[data-simple-box-toggle="${id}"]`)!
    expect(toggle('sales').getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-simple-box-waiting]')).toBeNull()
    await act(async () => { toggle('sales').click() })
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('sales')
    act(() => { root.render(render(['sales', 'support'])) })
    expect(toggle('sales').getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-simple-tile-id="bo"]')).toBeNull()
    // Bo waits in Sales; Ann in Support does not, and a paused coworker never does.
    expect(toggle('sales').querySelector('[data-simple-box-waiting]')).not.toBeNull()
    expect(toggle('support').querySelector('[data-simple-box-waiting]')).toBeNull()
    expect(toggle('sales').querySelector('[data-simple-box-count]')?.textContent).toBe('2')
})

test('New Box and a Box\'s menu open the board\'s dialogs, and are absent where the board cannot change its Boxes', async () => {
    const onNewBox = vi.fn(), onBoxDialog = vi.fn()
    const host = mount(<DesktopSimpleSidebar workspaceMenu={null} selectedId={null} foremanOpen={false} onOpenCoworker={vi.fn()} onNewCoworker={vi.fn()}
        agents={[made('bo', 'Bo', '1')]} statuses={{}} previews={{}} boxes={BOXES} boxOf={id => HOME[id] ?? null} onNewBox={onNewBox} onBoxDialog={onBoxDialog} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="New Box"]')!.click() })
    expect(onNewBox).toHaveBeenCalledOnce()
    const open = async () => {
        const more = host.querySelector<HTMLButtonElement>('button[aria-label="Actions for Support"]')!
        more.focus()
        await act(async () => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
        return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    }
    const items = await open()
    // Upstream's "who can access it" is left out: one person per workspace on this Mac.
    expect(items.map(item => item.textContent)).toEqual(['Rename', 'Delete'])
    await act(async () => { items[0].click() })
    expect(onBoxDialog).toHaveBeenCalledExactlyOnceWith('rename', 'support')
    await act(async () => { (await open())[1].click() })
    expect(onBoxDialog).toHaveBeenLastCalledWith('delete', 'support')
    const bare = mount(<DesktopSimpleSidebar workspaceMenu={null} selectedId={null} foremanOpen={false} onOpenCoworker={vi.fn()} onNewCoworker={vi.fn()}
        agents={[made('bo', 'Bo', '1')]} statuses={{}} previews={{}} boxes={BOXES} boxOf={id => HOME[id] ?? null} />)
    expect(bare.querySelector('button[aria-label="New Box"]')).toBeNull()
    expect(bare.querySelector('button[aria-label="Actions for Support"]')).toBeNull()
})

test('with several Boxes and no coworker the Boxes are listed; with one Box or none the first coworker is offered', () => {
    const empty = (boxes: typeof BOXES) => mount(<DesktopSimpleSidebar workspaceMenu={null} selectedId={null} foremanOpen={false} onOpenCoworker={vi.fn()} onNewCoworker={vi.fn()}
        agents={[]} statuses={{}} previews={{}} boxes={boxes} boxOf={() => null} />)
    const several = empty(BOXES)
    expect(several.textContent).not.toContain('No coworkers yet')
    expect([...several.querySelectorAll('[data-simple-box-empty]')].map(row => row.textContent)).toEqual(['No coworkers', 'No coworkers', 'No coworkers'])
    for (const host of [empty(BOXES.slice(0, 1)), empty([])]) {
        expect(host.textContent).toContain('No coworkers yet')
        expect(host.querySelector('section[data-simple-box-id]')).toBeNull()
    }
})
