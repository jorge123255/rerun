// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { emptyBoardAttention, type BoardActivityStatus } from '@/lib/desktop/board-activity'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { seedDesktopUsageWaits } from '@/lib/desktop/use-usage-wait'
import { BOARD_BOUNCE_MS, BOARD_DROP_SPREAD_MS, BOARD_ENTRANCE_MAX_MS } from '@/lib/desktop/board-motion'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const confetti = vi.hoisted(() => ({ fire: vi.fn(async () => true) }))
vi.mock('@/lib/desktop/board-confetti', () => ({ fireBoardConfetti: confetti.fire }))
import { DesktopBoard } from './DesktopBoard'

type Props = ComponentProps<typeof DesktopBoard>
const coworker = (id: string, enabled = true) => ({ id, name: id, description: '', createdAt: id, updatedAt: '', enabled })
const box = (id: string, index: number) => ({ id, name: id, col_start: index * 30, row_start: 0, col_end: index * 30 + 23, row_end: 23 })
const boardOf = (boxes: string[], ids: string[], revision = 1): DesktopBoardState => ({ revision, spaces: boxes.map(box),
    placements: ids.map((agentId, index) => ({ agentId, spaceId: boxes[0], col: (index % 10) * 2, row: Math.floor(index / 10) * 2 })) })
const snapshot = (statuses: Record<string, BoardActivityStatus>) => ({ statuses, attention: emptyBoardAttention() })

let root: Root | undefined
let host: HTMLElement
const reduce = (matches: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
async function show(props: Partial<Props> & Pick<Props, 'agents'>) {
    if (!root) { host = document.body.appendChild(document.createElement('div')); root = createRoot(host) }
    await act(async () => { root!.render(<DesktopBoard workspaceName="Studio" workspaceId={1} onOpen={() => {}} onCreate={() => {}} {...props} />) })
}
async function close() { await act(async () => { root?.unmount() }); root = undefined; host?.remove() }
const tile = (id: string) => host.querySelector<HTMLElement>(`[data-tile-id="${id}"]`)!
const figure = (id: string) => tile(id).querySelector<HTMLElement>('[data-buddy-depth], [style*="--buddy-depth"]') ?? tile(id).querySelector<HTMLElement>('svg')!.parentElement!
const dropping = (id: string) => tile(id).style.animation.includes('agent-drop-in')
const dropDelay = (id: string) => Number(/(\d+)ms backwards/.exec(tile(id).style.animation)?.[1])

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    reduce(false)
})
afterEach(async () => { await close(); seedDesktopUsageWaits([]); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

test('each state has its own figure: working bobs, Needs you nudges sparsely, idle is still, off and unreachable sleep', async () => {
    const agents = [coworker('busy'), coworker('asks'), coworker('rests'), coworker('lost'), coworker('off', false)]
    await show({ agents, activitySnapshot: snapshot({ busy: 'working', asks: 'waiting_human', rests: 'idle', lost: 'unreachable', off: 'idle' }) })
    expect(figure('busy').dataset.buddyMotion).toBe('bob')
    expect(figure('busy').dataset.buddyCue).toBeUndefined()
    expect(figure('asks').dataset.buddyCue).toBe('nudge')
    expect(figure('asks').dataset.buddyMotion).toBeUndefined()
    for (const id of ['rests', 'lost', 'off']) {
        expect(figure(id).dataset.buddyMotion).toBeUndefined()
        expect(figure(id).dataset.buddyCue).toBeUndefined()
    }
    // Asleep is desaturated and dimmed; idle is neither.
    expect(figure('rests').style.filter).toBe('')
    expect(tile('rests').style.opacity).toBe('1')
    for (const id of ['lost', 'off']) {
        expect(figure(id).style.filter).toContain('saturate')
        expect(Number(tile(id).style.opacity)).toBeLessThan(1)
    }
    // Names and roles are untouched.
    expect(tile('asks').getAttribute('role')).toBe('button')
    expect(tile('busy').getAttribute('aria-label')).toBe('Open chat with busy')
})

test('a coworker waiting for its plan to reset sleeps like an unreachable one, and says why', async () => {
    seedDesktopUsageWaits([{ agentId: 'waits', sessionId: 's1' }, { agentId: 'busy', sessionId: null }])
    await show({ agents: [coworker('waits'), coworker('busy'), coworker('rests')], activitySnapshot: snapshot({ waits: 'idle', busy: 'working', rests: 'idle' }) })
    expect(figure('waits').style.filter).toContain('saturate')
    expect(Number(tile('waits').style.opacity)).toBeLessThan(1)
    expect(figure('waits').dataset.buddyCue).toBeUndefined()
    expect(host.querySelector('[data-board-activity="waits"]')!.textContent).toBe('waits: Idle; Waiting for its plan to reset')
    // Work in hand still shows as work.
    expect(figure('busy').dataset.buddyMotion).toBe('bob')
    expect(host.querySelector('[data-board-activity="busy"]')!.textContent).toBe('busy: Working')
    expect(figure('rests').style.filter).toBe('')
    await act(async () => { seedDesktopUsageWaits([]) })
    expect(figure('waits').style.filter).toBe('')
})

test('a run finishing gives one bounce, then the figure is still; the first read after opening does not bounce', async () => {
    const agents = [coworker('busy'), coworker('rests')]
    await show({ agents, activitySnapshot: snapshot({ busy: 'unknown', rests: 'unknown' }) })
    await show({ agents, activitySnapshot: snapshot({ busy: 'working', rests: 'idle' }) })
    expect(figure('rests').dataset.buddyCue).toBeUndefined()
    await show({ agents, activitySnapshot: snapshot({ busy: 'idle', rests: 'idle' }) })
    expect(figure('busy').dataset.buddyCue).toBe('bounce')
    expect(figure('rests').dataset.buddyCue).toBeUndefined()
    await act(async () => { vi.advanceTimersByTime(BOARD_BOUNCE_MS + 1) })
    expect(figure('busy').dataset.buddyCue).toBeUndefined()
    // Staying idle does not bounce again.
    await show({ agents, activitySnapshot: snapshot({ busy: 'idle', rests: 'idle' }) })
    expect(figure('busy').dataset.buddyCue).toBeUndefined()
})

test('a change of state fades the old look out over the new one', async () => {
    const agents = [coworker('busy')]
    await show({ agents, activitySnapshot: snapshot({ busy: 'working' }) })
    expect(host.querySelector('[data-buddy-leaving]')).toBeNull()
    await show({ agents, activitySnapshot: snapshot({ busy: 'unreachable' }) })
    const leaving = tile('busy').querySelector<SVGElement>('[data-buddy-leaving]')!
    expect(leaving.dataset.buddyLeaving).toBe('working')
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(figure('busy').style.transition).toContain('filter')
    await act(async () => { leaving.dispatchEvent(new Event('animationend', { bubbles: true })) })
    expect(host.querySelector('[data-buddy-leaving]')).toBeNull()
})

test('with Reduce motion on nothing moves: no bob, nudge, bounce, fade or drop-in, and no confetti', async () => {
    reduce(true)
    const agents = [coworker('busy'), coworker('asks')]
    await show({ agents, board: boardOf(['a'], ['busy', 'asks']), activitySnapshot: snapshot({ busy: 'working', asks: 'waiting_human' }) })
    expect(figure('busy').dataset.buddyMotion).toBeUndefined()
    expect(figure('asks').dataset.buddyCue).toBeUndefined()
    await show({ agents: [...agents, coworker('new')], board: boardOf(['a', 'b'], ['busy', 'asks', 'new'], 2), teamPlacedSignal: 1, activitySnapshot: snapshot({ busy: 'idle', asks: 'idle', new: 'idle' }) })
    expect(figure('busy').dataset.buddyCue).toBeUndefined()
    expect(host.querySelector('[data-buddy-leaving]')).toBeNull()
    expect(dropping('new')).toBe(false)
    expect(host.querySelector('.iso-space-draw')).toBeNull()
    // The state itself still changed at once.
    expect(host.querySelector('[data-board-activity="busy"]')!.getAttribute('data-status')).toBe('idle')
    await act(async () => { vi.advanceTimersByTime(BOARD_ENTRANCE_MAX_MS + 100) })
    expect(confetti.fire).not.toHaveBeenCalled()
})

test('what is on the board when it opens does not drop in, on a reload or a restart', async () => {
    const agents = [coworker('one'), coworker('two')], board = boardOf(['a'], ['one', 'two'])
    await show({ agents, board })
    expect(dropping('one') || dropping('two')).toBe(false)
    expect(host.querySelector('.iso-space-draw')).toBeNull()
    // A refresh that brings the same board back changes nothing.
    await show({ agents: [...agents], board: { ...board, revision: 2 } })
    expect(dropping('one') || dropping('two')).toBe(false)
    // The build a restart reads again has nobody arriving for it.
    await show({ agents, board, teamPlacedSignal: 1 })
    await act(async () => { vi.advanceTimersByTime(BOARD_ENTRANCE_MAX_MS + 100) })
    expect(confetti.fire).not.toHaveBeenCalled()
    await close()
    await show({ agents: [...agents, coworker('three')], board: boardOf(['a', 'b'], ['one', 'two', 'three']) })
    expect(dropping('one') || dropping('two') || dropping('three')).toBe(false)
    expect(host.querySelector('.iso-space-draw')).toBeNull()
})

test('another workspace opening in the same board is simply there', async () => {
    await show({ agents: [coworker('one')], board: boardOf(['a'], ['one']), workspaceId: 1 })
    await show({ agents: [coworker('other'), coworker('team')], board: boardOf(['z'], ['other', 'team']), workspaceId: 2 })
    expect(dropping('other') || dropping('team')).toBe(false)
    expect(host.querySelector('.iso-space-draw')).toBeNull()
})

test('a coworker added by hand or copied drops in once, without confetti', async () => {
    const agents = [coworker('one')]
    await show({ agents, board: boardOf(['a'], ['one']) })
    await show({ agents: [...agents, coworker('copy')], board: boardOf(['a'], ['one', 'copy'], 2) })
    expect(dropping('copy')).toBe(true)
    expect(dropDelay('copy')).toBe(0)
    expect(dropping('one')).toBe(false)
    // Clicks are not held back by the entrance.
    expect(tile('copy').getAttribute('role')).toBe('button')
    await act(async () => { vi.advanceTimersByTime(BOARD_ENTRANCE_MAX_MS + 100) })
    expect(dropping('copy')).toBe(false)
    expect(confetti.fire).not.toHaveBeenCalled()
    // It never arrives a second time.
    await show({ agents: [...agents, coworker('copy')], board: boardOf(['a'], ['one', 'copy'], 3) })
    expect(dropping('copy')).toBe(false)
})

test('an approved team draws its Boxes in, drops its coworkers in one after another, then one burst of confetti', async () => {
    const agents = [coworker('one')]
    await show({ agents, board: boardOf(['a'], ['one']) })
    const team = ['t1', 't2', 't3']
    // The Boxes arrive with the refreshed board, the coworkers with the next read.
    await show({ agents, board: boardOf(['a', 'sales'], ['one'], 2) })
    expect(host.querySelectorAll('.iso-space-draw').length).toBe(1)
    await show({ agents: [...agents, ...team.map(id => coworker(id))], board: boardOf(['a', 'sales'], ['one', ...team], 2), teamPlacedSignal: 1 })
    expect(team.map(dropDelay)).toEqual([0, 100, 200])
    expect(dropping('one')).toBe(false)
    expect(confetti.fire).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(800) })
    expect(confetti.fire).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(BOARD_ENTRANCE_MAX_MS) })
    expect(confetti.fire).toHaveBeenCalledTimes(1)
    expect(confetti.fire).toHaveBeenCalledWith(host.querySelector('[data-testid="desktop-team-board"]'))
    expect(team.some(dropping)).toBe(false)
    expect(host.querySelector('.iso-space-draw')).toBeNull()
    // The same finished build read again celebrates nothing.
    await show({ agents: [...agents, ...team.map(id => coworker(id))], board: boardOf(['a', 'sales'], ['one', ...team], 2), teamPlacedSignal: 2 })
    await act(async () => { vi.advanceTimersByTime(BOARD_ENTRANCE_MAX_MS) })
    expect(confetti.fire).toHaveBeenCalledTimes(1)
})

test('a large team still lands within a second and a half', async () => {
    await show({ agents: [], board: boardOf(['a'], []) })
    const team = Array.from({ length: 30 }, (_, index) => `t${String(index).padStart(2, '0')}`)
    await show({ agents: team.map(id => coworker(id)), board: boardOf(['a'], team, 2), teamPlacedSignal: 1 })
    const delays = team.map(dropDelay)
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
    expect(new Set(delays).size).toBeGreaterThan(20)
    expect(Math.max(...delays)).toBeLessThanOrEqual(BOARD_DROP_SPREAD_MS)
    await act(async () => { vi.advanceTimersByTime(BOARD_ENTRANCE_MAX_MS) })
    expect(confetti.fire).toHaveBeenCalledTimes(1)
})

test('nothing arrives while the window is hidden', async () => {
    await show({ agents: [coworker('one')], board: boardOf(['a'], ['one']) })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await show({ agents: [coworker('one'), coworker('two')], board: boardOf(['a'], ['one', 'two'], 2), teamPlacedSignal: 1 })
    expect(dropping('two')).toBe(false)
    await act(async () => { vi.advanceTimersByTime(BOARD_ENTRANCE_MAX_MS + 100) })
    expect(confetti.fire).not.toHaveBeenCalled()
})
