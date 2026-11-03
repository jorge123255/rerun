// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopBoard } from './DesktopBoard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents = [
    { id: 'researcher', name: 'Researcher', description: '', createdAt: '', updatedAt: '' },
    { id: 'reviewer', name: 'Reviewer', description: '', createdAt: '', updatedAt: '' },
]
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

const statusOf = (name: string) => document.querySelector(`[data-board-activity="${name}"]`)?.getAttribute('data-status')

test('only the busy coworker changes, returns to idle, and a failed read is not idle', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let reply: () => Response = () => Response.json({ agents: { researcher: 'idle', reviewer: 'idle' } })
    const fetcher = vi.fn(async (url: string) => { expect(url).toBe('/api/desktop/board-activity'); return reply() })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const onOpen = vi.fn()
    await act(async () => { root.render(<DesktopBoard agents={agents} workspaceName="W" onOpen={onOpen} onCreate={() => {}} />) })
    expect(statusOf('Researcher')).toBe('idle')
    expect(statusOf('Reviewer')).toBe('idle')

    reply = () => Response.json({ agents: { researcher: 'working', reviewer: 'idle' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(statusOf('Researcher')).toBe('working')
    expect(statusOf('Reviewer')).toBe('idle')
    expect(container.textContent).toContain('Researcher: Working')

    reply = () => Response.json({ agents: { researcher: 'idle', reviewer: 'idle' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(statusOf('Researcher')).toBe('idle')

    reply = () => Response.json({ error: 'down' }, { status: 500 })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(statusOf('Researcher')).toBe('unreachable')
    expect(statusOf('Reviewer')).toBe('unreachable')
    expect(container.textContent).toContain('Activity unavailable')

    // Tiles still open chats by click and keyboard.
    const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Reviewer"]')!
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpen).toHaveBeenCalledWith('reviewer')

    // Unmounting (leaving the board) stops polling.
    const calls = fetcher.mock.calls.length
    await act(async () => { root.unmount() })
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher.mock.calls.length).toBe(calls)
})

test('does not poll while the window is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const fetcher = vi.fn(async () => Response.json({ agents: {} }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopBoard agents={agents} workspaceName="W" onOpen={() => {}} onCreate={() => {}} />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).not.toHaveBeenCalled()
    expect(statusOf('Researcher')).toBe('unknown')
    await act(async () => { root.unmount() })
})
