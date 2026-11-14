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

const attentionItem = (agentId: string, sessionId: string, updatedAt: string, kind: 'question' | 'approval' = 'question') => ({
    id: `${kind}-${sessionId}`, agentId, sessionId, agentName: agentId, agentEnabled: true,
    title: `Chat ${sessionId}`, summary: 'Please choose a version.', kind, updatedAt,
})
const withAttention = (statuses: Record<string, string>, items: ReturnType<typeof attentionItem>[]) => Response.json({
    agents: statuses, attention: { items, unavailableAgentIds: [], checkedAt: '2026-11-04T12:00:00Z' },
})

test('Needs you uses the original hand state and tile/context Open chat both select the newest owned request', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.stubGlobal('fetch', vi.fn(async () => withAttention({ researcher: 'waiting_human', reviewer: 'working' }, [
        attentionItem('researcher', 'older', '2026-11-03T12:00:00Z'),
        attentionItem('researcher', 'newest-owned', '2026-11-04T11:00:00Z', 'approval'),
        attentionItem('reviewer', 'foreign-newest', '2026-11-04T12:00:00Z'),
    ])))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), onOpen = vi.fn(), onOpenConversation = vi.fn()
    await act(async () => { root.render(<DesktopBoard agents={agents} workspaceName="W" onOpen={onOpen} onOpenConversation={onOpenConversation} onCreate={() => {}} />) })
    const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Researcher, Needs you"]')!
    expect(tile).not.toBeNull()
    expect(statusOf('Researcher')).toBe('waiting_human')
    expect(statusOf('Reviewer')).toBe('working')
    expect(container.textContent).toContain('Researcher: Needs you')
    expect(tile.querySelector('.lucide-hand')).not.toBeNull()
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const target = { id: 'newest-owned', agentId: 'researcher', agentName: 'Researcher', title: 'Chat newest-owned' }
    expect(onOpenConversation).toHaveBeenLastCalledWith(target)
    expect(onOpen).not.toHaveBeenCalled()
    await act(async () => {
        tile.focus()
        tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    const open = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Open chat')!
    expect(open).toBeDefined()
    await act(async () => { open.click() })
    expect(onOpenConversation).toHaveBeenCalledTimes(2)
    expect(onOpenConversation).toHaveBeenLastCalledWith(target)
    expect(container.querySelector('[data-tile-id="researcher"]')).toBe(tile)
    const workingTile = container.querySelector<HTMLElement>('[aria-label="Open chat with Reviewer, Needs you"]')!
    await act(async () => { workingTile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpenConversation).toHaveBeenLastCalledWith({ id: 'foreign-newest', agentId: 'reviewer', agentName: 'Reviewer', title: 'Chat foreign-newest' })
    await act(async () => { root.unmount() })
})

test('an inactive coworker keeps its original inactive tile while opening known pending history without enabling', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.stubGlobal('fetch', vi.fn(async () => withAttention({ researcher: 'waiting_human', reviewer: 'idle' }, [
        { ...attentionItem('researcher', 'pending-disabled', '2026-11-04T11:00:00Z'), agentEnabled: false },
    ])))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), onOpen = vi.fn(), onOpenConversation = vi.fn(), onSetEnabled = vi.fn()
    await act(async () => { root.render(<DesktopBoard agents={agents.map(agent => ({ ...agent, enabled: agent.id !== 'researcher' }))}
        workspaceName="W" onOpen={onOpen} onOpenConversation={onOpenConversation} onSetEnabled={onSetEnabled} onCreate={() => {}} />) })
    expect(statusOf('Researcher')).toBe('inactive')
    const tile = container.querySelector<HTMLElement>('[data-tile-id="researcher"]')!
    expect(tile.querySelector('.lucide-lock')).not.toBeNull()
    expect(tile.querySelector('.lucide-hand')).toBeNull()
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpenConversation).toHaveBeenCalledWith({ id: 'pending-disabled', agentId: 'researcher', agentName: 'Researcher', title: 'Chat pending-disabled' })
    expect(onSetEnabled).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
})

test('a failed read clears the old target and foreign-only attention cannot route a coworker into another chat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let reply = () => withAttention({ researcher: 'waiting_human', reviewer: 'idle' }, [attentionItem('researcher', 'old-target', '2026-11-04T11:00:00Z')])
    vi.stubGlobal('fetch', vi.fn(async () => reply()))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), onOpen = vi.fn(), onOpenConversation = vi.fn()
    await act(async () => { root.render(<DesktopBoard agents={agents} workspaceName="W" onOpen={onOpen} onOpenConversation={onOpenConversation} onCreate={() => {}} />) })
    reply = () => Response.json({ error: 'Offline' }, { status: 503 })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(statusOf('Researcher')).toBe('unreachable')
    const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Researcher"]')!
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpen).toHaveBeenCalledWith('researcher')
    expect(onOpenConversation).not.toHaveBeenCalled()
    reply = () => withAttention({ researcher: 'waiting_human', reviewer: 'idle' }, [attentionItem('deleted-owner', 'foreign', '2026-11-04T12:00:00Z')])
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(statusOf('Researcher')).toBe('unknown')
    expect(container.textContent).toContain('Researcher: Checking activity')
    await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpenConversation).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
})

test('shows an unopened result on its coworker tile and opens the exact saved chat', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const at = '2026-11-04T12:00:00Z'
    const fetcher = vi.fn(async (url: string) => {
        if (url === '/api/desktop/board-activity') return withAttention({ researcher: 'idle', reviewer: 'idle' }, [])
        return Response.json({ items: [{
            id: 'done:result', agentId: 'researcher', agentName: 'Researcher', agentEnabled: true,
            sessionId: 'result-chat', sessionIds: ['result-chat'], title: 'Morning result', message: 'The result',
            source: 'chat', slug: null, count: 1, completedAt: at, completionIds: ['result-terminal'],
        }], nextCursor: null, unavailableAgentIds: [], enabledAt: at, checkedAt: at })
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), onOpen = vi.fn(), onOpenConversation = vi.fn()
    await act(async () => { root.render(<DesktopBoard agents={agents} workspaceName="W" onOpen={onOpen} onOpenConversation={onOpenConversation} onCreate={() => {}} />) })
    const researcher = container.querySelector<HTMLElement>('[data-tile-id="researcher"]')!
    const reviewer = container.querySelector<HTMLElement>('[data-tile-id="reviewer"]')!
    expect(researcher.querySelector('.lucide-flag')).not.toBeNull()
    expect(reviewer.querySelector('.lucide-flag')).toBeNull()
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/completions')).toHaveLength(1)
    await act(async () => researcher.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ id: 'result-chat', agentId: 'researcher', agentName: 'Researcher', title: 'Morning result' })
    expect(onOpen).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/read'))).toBe(false)
    await act(async () => root.unmount())
})
