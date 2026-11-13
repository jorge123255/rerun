// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopAgentView } from '../DesktopApp'
import { DesktopSimpleSidebar } from './DesktopSimpleSidebar'
import { DesktopViewMenuRow } from './DesktopViewMenuRow'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@rerun/ui/foreman', () => ({ Orb: () => null }))
vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: () => null, buddyMoodOfStatus: () => 'idle' }))

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

test('lists coworkers most recently active first with one line of where each stands', async () => {
    const onOpen = vi.fn(), onForeman = vi.fn(), onSearch = vi.fn(), onNew = vi.fn()
    const host = mount(<DesktopSimpleSidebar workspaceMenu={<span>menu</span>} selectedId="bo" foremanOpen={false}
        agents={[agent('ann', 'Ann'), agent('bo', 'Bo'), agent('cy', 'Cy', { enabled: false }), agent('di', 'Di'), agent('ed', 'Ed', { description: '' })]}
        statuses={{ ann: 'working', bo: 'waiting_human', cy: 'working', di: 'unreachable', ed: 'idle' }}
        previews={{ ann: { title: 'Q4 prospects', updatedAt: '2026-11-13T10:00:00.000Z' }, bo: { title: 'Approve the invoice', updatedAt: '2026-11-13T12:00:00.000Z' }, di: { title: 'Weekly report', updatedAt: '2026-11-12T10:00:00.000Z', lastMessage: { text: 'Send it on Monday', mine: true } } }}
        onOpenCoworker={onOpen} onOpenForeman={onForeman} onSearch={onSearch} onNewCoworker={onNew} />)
    const tiles = [...host.querySelectorAll<HTMLButtonElement>('[data-simple-tile-id]')]
    expect(tiles.map(tile => tile.dataset.simpleTileId)).toEqual(['bo', 'ann', 'di', 'cy', 'ed'])
    const lines = tiles.map(tile => tile.querySelector('.text-xs')?.textContent)
    // Waiting reads its conversation, work its subject, a quiet coworker its last message, paused wins over work.
    expect(lines).toEqual(['Approve the invoice', 'Working · Q4 prospects', 'You: Send it on Monday', 'Paused', ' '])
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
