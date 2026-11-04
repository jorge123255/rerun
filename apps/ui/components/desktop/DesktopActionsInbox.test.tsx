// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopActionsInbox } from './DesktopActionsInbox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const checkedAt = '2026-11-04T12:00:00.000Z'
const question = { id: 'q1', kind: 'question', agentId: 'researcher', agentName: 'Researcher', agentEnabled: true, sessionId: 's1', title: 'Filter before matching', summary: 'Should I filter by date before matching?', updatedAt: '2026-11-04T11:50:00.000Z' }
const approval = { id: 'a1', kind: 'approval', agentId: 'reviewer', agentName: 'Reviewer', agentEnabled: false, sessionId: 's2', title: 'Approve final report', summary: 'Approve publishing the final report.', updatedAt: '2026-11-04T11:55:00.000Z' }

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

const pillOf = (container: HTMLElement) => container.querySelector<HTMLElement>('button[aria-label^="Actions:"]')!
const panelOf = (container: HTMLElement) => container.querySelector('[aria-label="Actions inbox"]')

test('lists pending question and approval rows, opens a navigation hit, and stops polling on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let reply: () => Response = () => Response.json({ items: [question, approval], unavailableAgentIds: [], checkedAt })
    const fetcher = vi.fn(async () => reply())
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const onOpen = vi.fn()
    await act(async () => { root.render(<DesktopActionsInbox open onOpenConversation={onOpen} />) })

    expect(container.textContent).toContain('Should I filter by date before matching?')
    expect(container.textContent).toContain('Approve publishing the final report.')
    expect(container.textContent).toContain('2 pending')
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 2 pending')
    // A disabled coworker stays identifiable, next to its pending action.
    expect(container.textContent).toContain('Inactive')

    // Opening is navigation only: the exact DesktopConversationHit, nothing marked handled.
    const row = container.querySelector<HTMLElement>('[data-actions-inbox-item="q1"]')!
    await act(async () => { row.click() })
    expect(onOpen).toHaveBeenCalledWith({ id: 's1', agentId: 'researcher', agentName: 'Researcher', title: 'Filter before matching' })

    const calls = fetcher.mock.calls.length
    await act(async () => { root.unmount() })
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher.mock.calls.length).toBe(calls)
})

test('an empty read is Nothing to handle and a failed read is a distinct retry state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let reply: () => Response = () => Response.json({ items: [], unavailableAgentIds: [], checkedAt })
    const fetcher = vi.fn(async () => reply())
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })

    // Only a complete ready empty read may claim zero.
    expect(container.textContent).toContain('Nothing to handle')
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: no pending')

    reply = () => Response.json({ error: 'down' }, { status: 500 })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(container.textContent).not.toContain('Nothing to handle')
    expect(container.textContent).toContain("Can't reach the actions list")
    expect(container.textContent).toContain('Retry')
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: unavailable')

    await act(async () => { root.unmount() })
})

test('a partial read names unavailable coworkers and a hidden window does not poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let visible = false
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (visible ? 'visible' : 'hidden'))
    const fetcher = vi.fn(async () => Response.json({ items: [question], unavailableAgentIds: ['reviewer'], checkedAt }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).not.toHaveBeenCalled()

    visible = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(container.textContent).toContain("Some coworkers couldn't be reached")
    // Confirmed items stay usable next to the banner.
    expect(container.textContent).toContain('Should I filter by date before matching?')

    await act(async () => { root.unmount() })
})

test('rerendering never adds immediate reads — one read per interval tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = vi.fn(async () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open className="a" />) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    // A re-render (a changing className here) must not restart the interval and fetch immediately.
    await act(async () => { root.render(<DesktopActionsInbox open className="b" />) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { root.render(<DesktopActionsInbox open className="c" />) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => { root.unmount() })
})

test('a partial empty read shows partial state with Retry, never zero, and Retry recovers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let reply: () => Response = () => Response.json({ items: [], unavailableAgentIds: ['reviewer'], checkedAt })
    const fetcher = vi.fn(async () => reply())
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: partial — some coworkers unavailable')
    expect(container.textContent).toContain("Some coworkers couldn't be reached")
    expect(container.textContent).not.toContain('Nothing to handle')
    expect(container.textContent).not.toContain('No pending')

    // Retry is available on a partial read, not only a total failure, and refreshes the list.
    reply = () => Response.json({ items: [question], unavailableAgentIds: ['reviewer'], checkedAt })
    const retryButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Retry'))!
    await act(async () => { retryButton.click() })
    expect(container.textContent).toContain('Should I filter by date before matching?')
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 1 pending')

    await act(async () => { root.unmount() })
})

test('the loading label never claims no pending', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = vi.fn(() => new Promise<Response>(() => {})) // never resolves: stays loading
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: checking')
    expect(container.textContent).toContain('Checking for pending actions…')
    expect(container.textContent).not.toContain('No pending')
    expect(container.textContent).not.toContain('Nothing to handle')
    await act(async () => { root.unmount() })
})

test('closing cancels an in-flight read and reopening reads immediately', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const resolvers: ((response: Response) => void)[] = []
    const fetcher = vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        resolvers.push(resolve)
        init?.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted'); error.name = 'AbortError'; reject(error)
        })
    }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    let open = true
    const renderIt = () => root.render(<DesktopActionsInbox open={open} onOpenChange={next => { open = next }} />)
    await act(async () => { renderIt() })
    expect(fetcher).toHaveBeenCalledTimes(1)

    open = false
    await act(async () => { renderIt() })
    await act(async () => { await Promise.resolve() }) // let the aborted read settle
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).toHaveBeenCalledTimes(1)

    open = true
    await act(async () => { renderIt() })
    expect(fetcher).toHaveBeenCalledTimes(2)

    await act(async () => { resolvers[1]?.(Response.json({ items: [], unavailableAgentIds: [], checkedAt })) })
    expect(container.textContent).toContain('No pending')
    await act(async () => { root.unmount() })
})

test('outside pointer-down close keeps focus; explicit close and Escape return it to the pill', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = vi.fn(async () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox />) })
    const pill = pillOf(container)
    await act(async () => { pill.click() })
    expect(panelOf(container)).not.toBeNull()

    const input = document.createElement('input'); document.body.append(input); input.focus()
    expect(document.activeElement).toBe(input)
    await act(async () => { document.dispatchEvent(new Event('pointerdown')) })
    expect(panelOf(container)).toBeNull()
    // An outside close must not steal the focus back to the pill (e.g. from a chat input).
    expect(document.activeElement).toBe(input)

    await act(async () => { pill.click() })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(panelOf(container)).toBeNull()
    // Escape is an explicit close: the pill gets the focus back.
    expect(document.activeElement).toBe(pill)

    await act(async () => { root.unmount() })
})
