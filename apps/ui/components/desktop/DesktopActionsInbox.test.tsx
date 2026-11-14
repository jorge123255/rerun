// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { coworkerRuleOf, mergeNotificationPrefs, normalizeNotificationPrefs } from '@rerun/contracts'
import type { DesktopNotificationRuleChange } from '@/lib/desktop/notifications'
import { DesktopActionsInbox } from './DesktopActionsInbox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notices = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(notices.show, { error: notices.error }) }))

const checkedAt = '2026-11-04T12:00:00.000Z'
const question = { id: 'q1', kind: 'question', agentId: 'researcher', agentName: 'Researcher', agentEnabled: true, sessionId: 's1', title: 'Filter before matching', summary: 'Should I filter by date before matching?', updatedAt: '2026-11-04T11:50:00.000Z' }
const approval = { id: 'a1', kind: 'approval', agentId: 'reviewer', agentName: 'Reviewer', agentEnabled: false, sessionId: 's2', title: 'Approve final report', summary: 'Approve publishing the final report.', updatedAt: '2026-11-04T11:55:00.000Z' }

// The inbox reads two endpoints on the same tick: the pending-inbox projection (shared attention
// minus the inbox's own read receipts) and the completion store (finished runs). The scaffolding
// below answers each URL with a payload of its own shape, so the counts and content stay
// deterministic. Mark-as-read posts land on the pending-inbox/read and completions/read routes.
const enabledAt = '2026-11-04T10:00:00.000Z'
const completionsEmpty = () => Response.json({ items: [], unavailableAgentIds: [], enabledAt, nextCursor: null, checkedAt })
const pendingReadOk = () => Response.json({ marked: 1, failedIds: [] })
const routedFetch = (pending: () => Response, completions: () => Response = completionsEmpty, read: () => Response = () => Response.json({ marked: 1 })) =>
    vi.fn((url: string, _init?: RequestInit) => {
        if (url === '/api/desktop/pending-inbox/read') return Promise.resolve(pendingReadOk())
        if (url === '/api/desktop/completions/read') return Promise.resolve(read())
        if (url === '/api/desktop/completions') return Promise.resolve(completions())
        return Promise.resolve(pending())
    })

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

const pillOf = (container: HTMLElement) => container.querySelector<HTMLElement>('button[aria-label^="Actions:"]')!
const panelOf = (container: HTMLElement) => container.querySelector('[aria-label="Actions inbox"]')

test('the inbox row menu mutes, unfollows and undoes one field without navigating or acknowledging the chat', async () => {
    let saved = normalizeNotificationPrefs({ version: 2, coworkers: { researcher: { mode: 'everything', follow: true } } })
    const patches: DesktopNotificationRuleChange[] = []
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        requests.push(url)
        if (url === '/api/desktop/notifications') {
            if (init?.method === 'PATCH') {
                const input: DesktopNotificationRuleChange = JSON.parse(String(init.body))
                const rule = coworkerRuleOf(saved, input.agentId)
                patches.push(input)
                if (rule[input.field] !== input.expected) return Response.json({}, { status: 409 })
                saved = mergeNotificationPrefs(saved, { coworkers: { [input.agentId]: { ...rule, [input.field]: input.value } } })
            }
            return Response.json(saved)
        }
        if (url === '/api/desktop/completions') return completionsEmpty()
        return Response.json({ items: [question], unavailableAgentIds: [], checkedAt })
    }))
    notices.show.mockClear()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onOpen = vi.fn(), onSettings = vi.fn(), onFold = vi.fn()
    const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    async function openMenu() {
        await act(async () => {
            const options = container.querySelector<HTMLButtonElement>('button[aria-label="Notification options"]')!
            options.focus()
            options.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        })
    }
    async function choose(label: string) {
        const item = menuItems().find(node => node.textContent?.trim() === label)
        expect(item).toBeDefined()
        await act(async () => {
            item!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
            item!.click()
        })
    }
    try {
        await act(async () => root.render(<DesktopActionsInbox open workspaceId={7} onOpenChange={onFold} onOpenConversation={onOpen} onOpenNotificationSettings={onSettings} />))
        await openMenu()
        expect(patches).toEqual([])
        await choose('Mute Researcher')
        expect(onFold).not.toHaveBeenCalled()
        expect(onOpen).not.toHaveBeenCalled()
        expect(patches).toEqual([{ workspaceId: 7, agentId: 'researcher', field: 'mode', expected: 'everything', value: 'muted' }])
        expect(notices.show).toHaveBeenCalledWith('Researcher is muted.', { action: { label: 'Undo', onClick: expect.any(Function) } })
        const undoMute = notices.show.mock.calls[0]?.[1]?.action?.onClick
        await openMenu()
        expect(menuItems().map(node => node.textContent?.trim())).not.toContain('Mute Researcher')
        await choose('Stop following its scheduled tasks')
        expect(coworkerRuleOf(saved, 'researcher')).toEqual({ mode: 'muted', follow: false })
        await act(async () => { undoMute() })
        expect(patches.at(-1)).toEqual({ workspaceId: 7, agentId: 'researcher', field: 'mode', expected: 'muted', value: 'everything' })
        expect(coworkerRuleOf(saved, 'researcher')).toEqual({ mode: 'everything', follow: false })
        expect(container.textContent).toContain(question.summary)
        await openMenu()
        await choose('Notification settings')
        expect(onSettings).toHaveBeenCalledExactlyOnceWith('researcher')
        expect(onFold).toHaveBeenCalledExactlyOnceWith(false)
        expect(onOpen).not.toHaveBeenCalled()
        expect(requests.some(url => url.endsWith('/read'))).toBe(false)
    } finally { await act(async () => root.unmount()) }
})

test('an attention row names its coworker, opens that chat, and acknowledging it leaves the sibling', async () => {
    const info = { id: 'notify:ada:chat:run:call', kind: 'info', agentId: 'ada', agentName: 'Ada', agentEnabled: true, sessionId: 'chat-ada', title: 'Launch notes', summary: 'Please review the launch notes', updatedAt: checkedAt, requestedAt: checkedAt }
    const sibling = { ...info, id: 'notify:ada:other:run:call', sessionId: 'chat-other', title: 'Other chat', summary: 'Leave this one unread' }
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/desktop/pending-inbox/read') { bodies.push(JSON.parse(String(init?.body))); return Promise.resolve(Response.json({ marked: 1, failedIds: [] })) }
        if (url === '/api/desktop/completions/read') return Promise.resolve(Response.json({ marked: 1 }))
        if (url === '/api/desktop/completions') return Promise.resolve(completionsEmpty())
        return Promise.resolve(Response.json({ items: [info, sibling], unavailableAgentIds: [], checkedAt }))
    }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), onOpen = vi.fn()
    await act(async () => root.render(<DesktopActionsInbox open onOpenConversation={onOpen} />))
    expect(container.textContent).toContain('Ada')
    expect(container.textContent).toContain('Please review the launch notes')
    const row = container.querySelector<HTMLElement>('[data-actions-inbox-item="notify:ada:chat:run:call"]')!
    await act(async () => row.querySelector<HTMLButtonElement>('button[aria-label="Mark as read"]')!.click())
    expect(bodies).toEqual([{ items: [{ id: info.id, kind: 'info', agentId: 'ada', sessionId: 'chat-ada' }] }])
    expect(container.textContent).toContain('Leave this one unread')
    expect(container.querySelector('[data-actions-inbox-item="notify:ada:chat:run:call"]')).toBeNull()
    await act(async () => root.unmount())
    const again = createRoot(container)
    await act(async () => again.render(<DesktopActionsInbox open onOpenConversation={onOpen} />))
    await act(async () => container.querySelector<HTMLElement>('[data-actions-inbox-item="notify:ada:chat:run:call"]')!.click())
    expect(onOpen).toHaveBeenCalledWith({ id: 'chat-ada', agentId: 'ada', agentName: 'Ada', title: 'Launch notes' })
    await act(async () => again.unmount())
})

test('browser takeover renders with original waiting metadata and opens its exact chat', async () => {
    const takeover = { ...question, id: 'browser-request', kind: 'takeover', summary: 'Review the browser marker' }
    vi.stubGlobal('fetch', routedFetch(() => Response.json({ items: [takeover], unavailableAgentIds: [], checkedAt })))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), onOpen = vi.fn()
    await act(async () => root.render(<DesktopActionsInbox open onOpenConversation={onOpen} />))
    expect(container.textContent).toContain('Review the browser marker')
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 1 pending')
    await act(async () => container.querySelector<HTMLElement>('[data-actions-inbox-item="browser-request"]')!.click())
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', agentId: 'researcher' }))
    await act(async () => root.unmount())
})

test('lists pending question and approval rows, opens a navigation hit, and stops polling on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const reply: () => Response = () => Response.json({ items: [question, approval], unavailableAgentIds: [], checkedAt })
    const fetcher = routedFetch(() => reply())
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
    const fetcher = routedFetch(() => reply())
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
    const fetcher = routedFetch(() => Response.json({ items: [question], unavailableAgentIds: ['reviewer'], checkedAt }))
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

test('rerendering never adds immediate reads — one read per endpoint per interval tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(() => Response.json({ items: [], unavailableAgentIds: [], checkedAt }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open className="a" />) })
    // One pending-inbox read and one completion read on mount.
    expect(fetcher).toHaveBeenCalledTimes(2)
    // A re-render (a changing className here) must not restart the interval and fetch immediately.
    await act(async () => { root.render(<DesktopActionsInbox open className="b" />) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fetcher).toHaveBeenCalledTimes(4)
    await act(async () => { root.render(<DesktopActionsInbox open className="c" />) })
    expect(fetcher).toHaveBeenCalledTimes(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fetcher).toHaveBeenCalledTimes(6)
    await act(async () => { root.unmount() })
})

test('a partial empty read shows partial state with Retry, never zero, and Retry recovers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let reply: () => Response = () => Response.json({ items: [], unavailableAgentIds: ['reviewer'], checkedAt })
    const fetcher = routedFetch(() => reply())
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

test('closing replaces in-flight reads with collapsed observation and reopening refreshes immediately', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const pending = new Map<string, Array<(response: Response) => void>>()
    const fetcher = vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const list = pending.get(url) ?? []
        list.push(resolve)
        pending.set(url, list)
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
    expect(fetcher).toHaveBeenCalledTimes(2)

    open = false
    await act(async () => { renderIt() })
    await act(async () => { await Promise.resolve() }) // let the aborted reads settle
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).toHaveBeenCalledTimes(4)

    open = true
    await act(async () => { renderIt() })
    expect(fetcher).toHaveBeenCalledTimes(6)

    // The reopened reads are the third request per endpoint: resolve them both.
    await act(async () => { pending.get('/api/desktop/pending-inbox')?.[2]?.(Response.json({ items: [], unavailableAgentIds: [], checkedAt })) })
    await act(async () => { pending.get('/api/desktop/completions')?.[2]?.(completionsEmpty()) })
    expect(container.textContent).toContain('No pending')
    await act(async () => { root.unmount() })
})

test('outside pointer-down close keeps focus; explicit close and Escape return it to the pill', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(() => Response.json({ items: [], unavailableAgentIds: [], checkedAt }))
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

test('current roster filters counts and unknown owners, and removed rows cannot reopen a coworker', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.stubGlobal('fetch', routedFetch(() => Response.json({ items: [question, approval], unavailableAgentIds: ['removed'], checkedAt })))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), onOpen = vi.fn()
    const researcher = { id: 'researcher', name: 'Renamed researcher', enabled: true }
    await act(async () => { root.render(<DesktopActionsInbox open agents={[researcher]} onOpenConversation={onOpen} />) })
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 1 pending')
    expect(container.textContent).toContain('Renamed researcher')
    expect(container.textContent).not.toContain('Reviewer')
    expect(container.textContent).not.toContain("Some coworkers couldn't be reached")
    const oldRow = container.querySelector<HTMLElement>('[data-actions-inbox-item="q1"]')!
    await act(async () => { oldRow.click() })
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ agentName: 'Renamed researcher', id: 's1' }))
    onOpen.mockClear()
    await act(async () => { root.render(<DesktopActionsInbox open agents={[]} onOpenConversation={onOpen} />) })
    expect(container.querySelector('[data-actions-inbox-item]')).toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: no pending')
    await act(async () => { oldRow.click() })
    expect(onOpen).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
})

test('a late response from the old roster cannot restore a deleted request', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const pending: { url: string; resolve: (value: Response) => void; signal?: AbortSignal | null }[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>(resolve => pending.push({ url, resolve, signal: init?.signal }))))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open agents={[{ id: 'researcher', name: 'Researcher' }]} />) })
    await act(async () => { root.render(<DesktopActionsInbox open agents={[]} />) })
    // One read per endpoint per render: the old roster's reads are cancelled when the scope changes.
    expect(pending).toHaveLength(4)
    expect(pending[0].signal?.aborted).toBe(true)
    expect(pending[1].signal?.aborted).toBe(true)
    // A late response for the new roster cannot bring back a request the roster has dropped.
    const attention = pending.filter(entry => entry.url === '/api/desktop/pending-inbox')
    await act(async () => { attention[1].resolve(Response.json({ items: [question], unavailableAgentIds: [], checkedAt })) })
    await act(async () => { pending.filter(entry => entry.url === '/api/desktop/completions')[1].resolve(completionsEmpty()) })
    await act(async () => { pending[0].resolve(Response.json({ items: [question], unavailableAgentIds: [], checkedAt })) })
    expect(container.querySelector('[data-actions-inbox-item]')).toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: no pending')
    await act(async () => { root.unmount() })
})


test('failure after a roster change does not relabel an old snapshot as current', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let respond: (value: Response) => void = () => {}
    let attentionCalls = 0
    const fetcher = vi.fn((url: string) => {
        if (url === '/api/desktop/completions') return Promise.resolve(completionsEmpty())
        attentionCalls += 1
        if (attentionCalls === 1) return Promise.resolve(Response.json({ items: [question], unavailableAgentIds: [], checkedAt }))
        return new Promise<Response>(resolve => { respond = resolve })
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const researcher = { id: 'researcher', name: 'Researcher' }
    await act(async () => { root.render(<DesktopActionsInbox open agents={[researcher, { id: 'old', name: 'Old' }]} />) })
    expect(container.querySelector('[data-actions-inbox-item="q1"]')).not.toBeNull()
    await act(async () => { root.render(<DesktopActionsInbox open agents={[researcher, { id: 'new', name: 'New' }]} />) })
    expect(container.querySelector('[data-actions-inbox-item]')).toBeNull()
    await act(async () => { respond(Response.json({ error: 'unavailable' }, { status: 503 })) })
    expect(container.querySelector('[data-actions-inbox-item]')).toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: unavailable')
    await act(async () => { root.unmount() })
})

const doneChat = { id: 'done:chat-s1', agentId: 'researcher', agentName: 'Researcher', agentEnabled: true, sessionId: 's1', sessionIds: ['s1'], title: 'Filter before matching', message: 'Here is the filtered list.', source: 'chat', slug: null, count: 1, completedAt: '2026-11-04T11:58:00.000Z', completionIds: ['run-1'] }
const doneScheduled = { id: 'done:sched', agentId: 'reviewer', agentName: 'Reviewer', agentEnabled: false, sessionId: 's3', sessionIds: ['s3', 's4'], title: 'nightly-sync', message: null, source: 'schedule', slug: 'nightly-sync', count: 2, completedAt: '2026-11-04T11:57:00.000Z', completionIds: ['run-2', 'run-3'] }
const completionsWith = (items: unknown[]) => () => Response.json({ items, unavailableAgentIds: [], enabledAt, nextCursor: null, checkedAt })

test('finished runs render as Done rows; Mark as read acknowledges the exact completion IDs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(
        () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }),
        completionsWith([doneChat, doneScheduled])
    )
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })

    // A chat row shows the bounded final-answer summary; a scheduled run folds under its slug.
    expect(container.textContent).toContain('Here is the filtered list.')
    expect(container.textContent).toContain('nightly-sync')
    expect(container.textContent).toContain('×2')
    expect(container.textContent).toContain('Reviewer finished its run')
    // The header and pill count finished runs; the disabled owner stays tagged.
    expect(container.textContent).toContain('3 done')
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 3 done')
    expect(container.textContent).toContain('Inactive')

    // Mark-as-read acknowledges exactly the displayed completion IDs, nothing newer.
    const readButton = Array.from(container.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Mark as read')!
    await act(async () => { readButton.click() })
    const post = fetcher.mock.calls.find(([url]) => url === '/api/desktop/completions/read')
    expect(post).toBeTruthy()
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ completionIds: ['run-1'] })
    expect(container.querySelector('[data-actions-inbox-done="done:chat-s1"]')).toBeNull()
    // A scheduled row's different terminal IDs are untouched.
    expect(container.querySelector('[data-actions-inbox-done="done:sched"]')).not.toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 2 done')

    await act(async () => { root.unmount() })
})

test('Mark all as read confirms first and acknowledges exactly the displayed completion IDs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(
        () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }),
        completionsWith([doneChat, doneScheduled])
    )
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })

    const markAll = Array.from(container.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Mark all as read')!
    await act(async () => { markAll.click() })
    // The original confirmation appears before anything is marked, with its count and warning.
    expect(document.body.textContent).toContain('Mark everything as read?')
    expect(document.body.textContent).toContain('2 items will leave this list. Requests still waiting on an answer are cleared too, without being answered.')
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/completions/read')).toHaveLength(0)
    const confirm = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Mark all as read')!
    await act(async () => { confirm.click() })
    const post = fetcher.mock.calls.find(([url]) => url === '/api/desktop/completions/read')
    expect(post).toBeTruthy()
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ completionIds: ['run-1', 'run-2', 'run-3'] })
    expect(container.querySelector('[data-actions-inbox-done]')).toBeNull()

    await act(async () => { root.unmount() })
})

test('opening a Done row navigates to the conversation and marks its group read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(
        () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }),
        completionsWith([doneChat, doneScheduled])
    )
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const onOpen = vi.fn()
    await act(async () => { root.render(<DesktopActionsInbox open onOpenConversation={onOpen} />) })

    const row = container.querySelector<HTMLElement>('[data-actions-inbox-done="done:chat-s1"]')!
    await act(async () => { row.click() })
    expect(onOpen).toHaveBeenCalledWith({ id: 's1', agentId: 'researcher', agentName: 'Researcher', title: 'Filter before matching' })
    // Opening acknowledges the folded group, like the original openItem→markSeen.
    const post = fetcher.mock.calls.find(([url]) => url === '/api/desktop/completions/read')
    expect(post).toBeTruthy()
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ completionIds: ['run-1'] })

    await act(async () => { root.unmount() })
})

test('a finished run in the conversation on screen is acknowledged as it lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const fetcher = routedFetch(
        () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }),
        completionsWith([doneChat])
    )
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open visibleSessionId="s1" />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const post = fetcher.mock.calls.find(([url]) => url === '/api/desktop/completions/read')
    expect(post).toBeTruthy()
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ completionIds: ['run-1'] })

    await act(async () => { root.unmount() })
})

test('a completion read failure shows its own Retry note and never a done count', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(
        () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }),
        () => Response.json({ error: 'down' }, { status: 500 })
    )
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })
    expect(container.textContent).toContain("Couldn't refresh finished runs.")
    expect(container.querySelector('[data-actions-inbox-done]')).toBeNull()
    expect(container.textContent).not.toContain('Nothing to handle')
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: unavailable')

    await act(async () => { root.unmount() })
})

test('an empty completion page with a cursor offers older runs instead of a false empty inbox', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt })
        if (url === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt, checkedAt, nextCursor: 'after seen' })
        expect(url).toBe('/api/desktop/completions?before=after+seen')
        return completionsWith([doneChat])()
    }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopActionsInbox open />) })
        expect(container.textContent).not.toContain('Nothing to handle')
        expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: more activity')
        const load = [...container.querySelectorAll('button')].find(button => button.textContent === 'Load older runs')!
        expect(load).toBeTruthy()
        await act(async () => { load.click() })
        expect(container.querySelector('[data-actions-inbox-done="done:chat-s1"]')).not.toBeNull()
        expect(container.textContent).not.toContain('Load older runs')
    } finally { await act(async () => { root.unmount() }) }
})

test('mark-read failure leaves a usable Done row and an explicit Retry without repeating POST', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let fail = true
    const fetcher = routedFetch(
        () => Response.json({ items: [], unavailableAgentIds: [], checkedAt }),
        completionsWith([doneChat]),
        () => Response.json({}, { status: fail ? 503 : 200 }),
    )
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopActionsInbox open />) })
        await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Mark as read"]')!.click() })
        expect(container.textContent).toContain("Couldn't mark finished runs as read. They are still here.")
        expect(container.querySelector('[data-actions-inbox-done="done:chat-s1"]')).not.toBeNull()
        await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
        expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/completions/read')).toHaveLength(1)
        fail = false
        await act(async () => { container.querySelector<HTMLElement>('[role="alert"] button')!.click() })
        expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/completions/read')).toHaveLength(2)
        expect(container.querySelector('[data-actions-inbox-done]')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('pending Mark as read posts the exact request target and hides only that row', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(() => Response.json({ items: [question, approval], unavailableAgentIds: [], checkedAt }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const onOpen = vi.fn()
    await act(async () => { root.render(<DesktopActionsInbox open onOpenConversation={onOpen} />) })

    // Rows sort by recency, so target the acknowledged row's own button.
    const readButton = container.querySelector<HTMLButtonElement>('[data-actions-inbox-item="q1"] button[aria-label="Mark as read"]')!
    await act(async () => { readButton.click() })
    const post = fetcher.mock.calls.find(([url]) => url === '/api/desktop/pending-inbox/read')
    expect(post).toBeTruthy()
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ items: [{ id: 'q1', kind: 'question', agentId: 'researcher', sessionId: 's1' }] })
    // Only the acknowledged row leaves; the other pending row and navigation stay intact.
    expect(container.querySelector('[data-actions-inbox-item="q1"]')).toBeNull()
    expect(container.querySelector('[data-actions-inbox-item="a1"]')).not.toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 1 pending')
    expect(onOpen).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
})

test('confirmed Mark all captures pending and done at confirmation opening; a later arrival stays unread', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let pending: () => Response = () => Response.json({ items: [question], unavailableAgentIds: [], checkedAt })
    const fetcher = routedFetch(() => pending(), completionsWith([doneChat]))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })

    const markAll = Array.from(container.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Mark all as read')!
    await act(async () => { markAll.click() })
    expect(document.body.textContent).toContain('Mark everything as read?')
    expect(document.body.textContent).toContain('2 items will leave this list. Requests still waiting on an answer are cleared too, without being answered.')
    // A newer pending request arrives in a poll while the confirmation is still open.
    const q2 = { ...question, id: 'q2', title: 'Filter again', summary: 'A newer question in the same chat.', updatedAt: '2026-11-04T11:59:00.000Z' }
    pending = () => Response.json({ items: [question, q2], unavailableAgentIds: [], checkedAt })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(container.textContent).toContain('A newer question in the same chat.')
    // The count was captured at opening and does not sweep the arrival in.
    expect(document.body.textContent).toContain('2 items will leave this list.')

    const confirm = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Mark all as read')!
    await act(async () => { confirm.click() })
    const pendingPost = fetcher.mock.calls.find(([url]) => url === '/api/desktop/pending-inbox/read')
    expect(pendingPost).toBeTruthy()
    expect(JSON.parse(String((pendingPost![1] as RequestInit).body))).toEqual({ items: [{ id: 'q1', kind: 'question', agentId: 'researcher', sessionId: 's1' }] })
    const donePost = fetcher.mock.calls.find(([url]) => url === '/api/desktop/completions/read')
    expect(JSON.parse(String((donePost![1] as RequestInit).body))).toEqual({ completionIds: ['run-1'] })
    // The captured rows left; the arrival after the dialog opened stays unread.
    expect(container.querySelector('[data-actions-inbox-item="q1"]')).toBeNull()
    expect(container.querySelector('[data-actions-inbox-item="q2"]')).not.toBeNull()
    expect(container.querySelector('[data-actions-inbox-done]')).toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 1 pending')

    await act(async () => { root.unmount() })
})

test('a new pending request in the same chat reappears after the earlier one was marked read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let pending: () => Response = () => Response.json({ items: [question], unavailableAgentIds: [], checkedAt })
    const fetcher = routedFetch(() => pending())
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopActionsInbox open />) })

    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Mark as read"]')!.click() })
    expect(container.querySelector('[data-actions-inbox-item="q1"]')).toBeNull()
    // The same session asks again: the new request id is not covered by the q1 receipt.
    const q2 = { ...question, id: 'q2', summary: 'A newer question in the same chat.', updatedAt: '2026-11-04T11:59:00.000Z' }
    pending = () => Response.json({ items: [q2], unavailableAgentIds: [], checkedAt })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(container.textContent).toContain('A newer question in the same chat.')
    expect(container.querySelector('[data-actions-inbox-item="q2"]')).not.toBeNull()
    expect(container.querySelector('[data-actions-inbox-item="q1"]')).toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 1 pending')

    await act(async () => { root.unmount() })
})

test('a pending mark-read failure keeps the row visible with a Retry that re-posts and recovers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let fail = true
    const fetcher = vi.fn((url: string, _init?: RequestInit) => {
        if (url === '/api/desktop/completions') return Promise.resolve(completionsEmpty())
        if (url === '/api/desktop/completions/read') return Promise.resolve(Response.json({ marked: 1 }))
        if (url === '/api/desktop/pending-inbox/read') return Promise.resolve(fail ? Response.json({}, { status: 503 }) : Response.json({ marked: 1, failedIds: [] }))
        return Promise.resolve(Response.json({ items: [question], unavailableAgentIds: [], checkedAt }))
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopActionsInbox open />) })
        await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Mark as read"]')!.click() })
        expect(container.textContent).toContain("Some pending requests couldn't be marked as read. They are still here.")
        expect(container.querySelector('[data-actions-inbox-item="q1"]')).not.toBeNull()
        // Polling refreshes the list but never re-posts a failed mark.
        await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
        expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/pending-inbox/read')).toHaveLength(1)
        fail = false
        await act(async () => { container.querySelector<HTMLElement>('[role="alert"] button')!.click() })
        expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/pending-inbox/read')).toHaveLength(2)
        expect(container.querySelector('[data-actions-inbox-item="q1"]')).toBeNull()
        expect(container.textContent).not.toContain("Some pending requests couldn't be marked as read.")
    } finally { await act(async () => { root.unmount() }) }
})

test('opening a pending row navigates but never marks it read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const fetcher = routedFetch(() => Response.json({ items: [question], unavailableAgentIds: [], checkedAt }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const onOpen = vi.fn()
    await act(async () => { root.render(<DesktopActionsInbox open onOpenConversation={onOpen} />) })

    const row = container.querySelector<HTMLElement>('[data-actions-inbox-item="q1"]')!
    await act(async () => { row.click() })
    expect(onOpen).toHaveBeenCalledWith({ id: 's1', agentId: 'researcher', agentName: 'Researcher', title: 'Filter before matching' })
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/pending-inbox/read')).toHaveLength(0)
    expect(container.querySelector('[data-actions-inbox-item="q1"]')).not.toBeNull()
    expect(pillOf(container).getAttribute('aria-label')).toBe('Actions: 1 pending')

    await act(async () => { root.unmount() })
})
