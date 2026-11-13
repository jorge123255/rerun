import { beforeEach, expect, test, vi } from 'vitest'
import { desktopSimpleInitialOpen, loadDesktopWorkspaceView, parseDesktopWorkspaceView, readDesktopSimpleLastOpened, rememberDesktopSimpleLastOpened, rememberDesktopWorkspaceView, resolveDesktopWorkspaceView } from './workspace-view'

beforeEach(() => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) } })
})

test('the view is the board until Simple is chosen, and the choice is remembered on this Mac', () => {
    expect(loadDesktopWorkspaceView()).toBeNull()
    expect(resolveDesktopWorkspaceView({ preference: null, placing: false })).toBe('board')
    rememberDesktopWorkspaceView('simple')
    expect(loadDesktopWorkspaceView()).toBe('simple')
    expect(parseDesktopWorkspaceView('grid')).toBeNull()
})

test('placing on the grid shows the board and the preference comes back afterwards', () => {
    expect(resolveDesktopWorkspaceView({ preference: 'simple', placing: true })).toBe('board')
    expect(resolveDesktopWorkspaceView({ preference: 'simple', placing: false })).toBe('simple')
})

test('opens the coworker open last while it still exists, else the most recently active one', () => {
    rememberDesktopSimpleLastOpened(1, 'ann')
    expect(readDesktopSimpleLastOpened(1)).toBe('ann')
    expect(readDesktopSimpleLastOpened(2)).toBeNull()
    expect(desktopSimpleInitialOpen({ remembered: 'ann', agentIds: ['ann', 'bo'], mostRecent: 'bo' })).toBe('ann')
    expect(desktopSimpleInitialOpen({ remembered: 'gone', agentIds: ['ann', 'bo'], mostRecent: 'bo' })).toBe('bo')
    expect(desktopSimpleInitialOpen({ remembered: null, agentIds: [], mostRecent: null })).toBeNull()
})
