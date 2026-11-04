// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { completionIdentityOf, type DesktopCompletionItem } from '@/lib/desktop/completed-actions'
import type { DesktopPendingInboxItem } from '@/lib/desktop/pending-inbox'
import { DesktopActionsInbox } from './DesktopActionsInbox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const checkedAt = '2026-11-04T12:00:00.000Z'
const enabledAt = '2026-11-04T10:00:00.000Z'
const question: DesktopPendingInboxItem = {
    id: 'question-first', kind: 'question', agentId: 'researcher', agentName: 'Researcher', agentEnabled: true,
    sessionId: 'chat-one', title: 'Research', summary: 'Which region should I use?', updatedAt: checkedAt,
}
const approval: DesktopPendingInboxItem = {
    id: 'approval-first', kind: 'approval', agentId: 'reviewer', agentName: 'Reviewer', agentEnabled: true,
    sessionId: 'review-chat', title: 'Review', summary: 'Approve the draft?', updatedAt: checkedAt,
}
const identity = (agentId: string, sessionId: string, terminalId: string) => completionIdentityOf({
    agentId, engineAgentId: `engine-${agentId}`, engineSessionId: `engine-${sessionId}`, terminalId,
})
const chatRun = identity('researcher', 'chat-one', 'chat-run-one')
const nextChatRun = identity('researcher', 'chat-one', 'chat-run-two')
const otherChatRun = identity('researcher', 'chat-two', 'other-chat-run')
const scheduledRuns = [
    identity('reviewer', 'scheduled-new', 'scheduled-run-new'),
    identity('reviewer', 'scheduled-old', 'scheduled-run-old'),
]
const nextScheduledRun = identity('reviewer', 'scheduled-next', 'scheduled-run-next')
const doneChat: DesktopCompletionItem = {
    id: 'done:chat-one', agentId: 'researcher', agentName: 'Researcher', agentEnabled: true,
    sessionId: 'chat-one', sessionIds: ['chat-one'], title: 'Research', message: 'Research is ready.',
    source: 'chat', slug: null, count: 1, completedAt: '2026-11-04T11:59:00.000Z', completionIds: [chatRun],
}
const otherChat: DesktopCompletionItem = {
    ...doneChat, id: 'done:chat-two', sessionId: 'chat-two', sessionIds: ['chat-two'],
    title: 'Separate research', completionIds: [otherChatRun],
}
// Two executions of one scheduled task belong to two distinct chats and form one inbox row.
const doneScheduled: DesktopCompletionItem = {
    id: 'done:reviewer:schedule:daily-review', agentId: 'reviewer', agentName: 'Reviewer', agentEnabled: true,
    sessionId: 'scheduled-new', sessionIds: ['scheduled-new', 'scheduled-old'], title: 'daily-review', message: null,
    source: 'schedule', slug: 'daily-review', count: 2, completedAt: '2026-11-04T11:58:00.000Z', completionIds: scheduledRuns,
}
const expandedSchedule: DesktopCompletionItem = {
    ...doneScheduled, sessionId: 'scheduled-next', sessionIds: ['scheduled-next', ...doneScheduled.sessionIds],
    count: 3, completedAt: checkedAt, completionIds: [nextScheduledRun, ...scheduledRuns],
}
const pendingResponse = (items: DesktopPendingInboxItem[] = [], unavailableAgentIds: string[] = []) =>
    Response.json({ items, unavailableAgentIds, checkedAt })
const doneResponse = (items: DesktopCompletionItem[] = [], unavailableAgentIds: string[] = []) =>
    Response.json({ items, unavailableAgentIds, enabledAt, checkedAt, nextCursor: null })
type Reply = () => Response | Promise<Response>
const api = (pending: Reply, done: Reply, write?: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'POST') {
            if (write) return write(url, init)
            if (url === '/api/desktop/pending-inbox/read') return Response.json({ marked: 1, failedIds: [] })
            if (url === '/api/desktop/completions/read') return Response.json({ marked: 1 })
        }
        if (url === '/api/desktop/pending-inbox') return pending()
        if (url === '/api/desktop/completions') return done()
        throw new Error(`Unexpected Actions request: ${url}`)
    })
const posts = (fetcher: ReturnType<typeof api>) => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
const pillOf = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label^="Actions:"]')!
const labelOf = (container: HTMLElement) => pillOf(container).getAttribute('aria-label')
const panelOf = (container: HTMLElement) => container.querySelector('[aria-label="Actions inbox"]')
const roots: Root[] = []
async function mount(content: ReactNode) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(content) })
    return { container, root }
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) }

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks()
})

test('the closed pill loads pending and exact finished-run totals, then observes new arrivals without marking read', async () => {
    let pending = [question]
    let done = [doneChat, doneScheduled]
    const fetcher = api(() => pendingResponse(pending), () => doneResponse(done))
    vi.stubGlobal('fetch', fetcher)
    const { container } = await mount(<DesktopActionsInbox />)

    expect(panelOf(container)).toBeNull()
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/pending-inbox')).toHaveLength(1)
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/desktop/completions')).toHaveLength(1)
    expect(posts(fetcher)).toEqual([])

    pending = [question, approval]
    done = [doneChat, expandedSchedule]
    await tick()
    expect(panelOf(container)).toBeNull()
    expect(labelOf(container)).toBe('Actions: 2 pending · 4 done')
    // The next head poll overlaps every previous terminal ID; none is counted twice.
    await tick()
    expect(labelOf(container)).toBe('Actions: 2 pending · 4 done')
    expect(posts(fetcher)).toEqual([])
})

test('a closed observer preserves visible-chat auto-read only for that conversation, never pending or mixed-session groups', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true)
    let done = [doneChat, otherChat, doneScheduled]
    const fetcher = api(() => pendingResponse([question]), () => doneResponse(done))
    vi.stubGlobal('fetch', fetcher)
    const view = (visibleSessionId: string) => <>
        <section aria-label="Coworker chat">Current conversation</section>
        <DesktopActionsInbox visibleSessionId={visibleSessionId} />
    </>
    const { container, root } = await mount(view('chat-one'))

    expect(panelOf(container)).toBeNull()
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')
    expect(posts(fetcher).map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
        ['/api/desktop/completions/read', { completionIds: [chatRun] }],
    ])
    await tick()
    expect(posts(fetcher)).toHaveLength(1)

    done = [{ ...doneChat, count: 2, completionIds: [nextChatRun, chatRun], completedAt: checkedAt }, otherChat, doneScheduled]
    await tick()
    expect(posts(fetcher).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { completionIds: [chatRun] }, { completionIds: [nextChatRun] },
    ])
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')

    // Seeing the newest scheduled chat must not clear another chat folded into its task row.
    await act(async () => { root.render(view('scheduled-new')) })
    await tick()
    expect(posts(fetcher)).toHaveLength(2)
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')
})

test('a hidden window pauses the closed observer and resumes current counts immediately when shown', async () => {
    let visible = false
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
    let pending = [question]
    let done = [doneChat, doneScheduled]
    const fetcher = api(() => pendingResponse(pending), () => doneResponse(done))
    vi.stubGlobal('fetch', fetcher)
    const { container } = await mount(<DesktopActionsInbox />)
    await tick()
    expect(fetcher).not.toHaveBeenCalled()
    expect(labelOf(container)).not.toBe('Actions: no pending')

    visible = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')
    visible = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    const before = fetcher.mock.calls.length
    pending = [question, approval]
    done = [doneChat, expandedSchedule]
    await tick(); await tick()
    expect(fetcher.mock.calls).toHaveLength(before)
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')

    visible = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(labelOf(container)).toBe('Actions: 2 pending · 4 done')
    expect(panelOf(container)).toBeNull()
    expect(posts(fetcher)).toEqual([])
})

test.each(['pending', 'done'] as const)('a closed %s read distinguishes failure and partial data from zero, retaining known counts on later failure', async source => {
    let phase: 'failed' | 'partial' | 'ready' = 'failed'
    const failure = () => Response.json({ error: 'Unavailable' }, { status: 503 })
    const fetcher = api(
        () => source !== 'pending' ? pendingResponse() : phase === 'failed' ? failure()
            : phase === 'partial' ? pendingResponse([], ['researcher']) : pendingResponse([question]),
        () => source !== 'done' ? doneResponse() : phase === 'failed' ? failure()
            : phase === 'partial' ? doneResponse([], ['reviewer']) : doneResponse([doneScheduled]),
    )
    vi.stubGlobal('fetch', fetcher)
    const { container } = await mount(<DesktopActionsInbox />)
    expect(labelOf(container)).toBe('Actions: unavailable')
    expect(container.textContent).not.toContain('No pending')

    phase = 'partial'
    await tick()
    expect(labelOf(container)).toBe('Actions: partial — some coworkers unavailable')
    expect(container.textContent).not.toContain('No pending')
    phase = 'ready'
    await tick()
    const known = source === 'pending' ? 'Actions: 1 pending' : 'Actions: 2 done'
    expect(labelOf(container)).toBe(known)
    phase = 'failed'
    await tick()
    expect(labelOf(container)).toBe(known)
    expect(panelOf(container)).toBeNull()
    expect(posts(fetcher)).toEqual([])
})

test('confirmed per-row reads update the closed count and a later request or task execution remains unread', async () => {
    let pending = [question]
    let done = [doneChat, doneScheduled]
    let confirmPending: (response: Response) => void = () => { throw new Error('Pending mark was not submitted') }
    const fetcher = api(() => pendingResponse(pending), () => doneResponse(done), (url, init) => {
        if (url === '/api/desktop/pending-inbox/read') return new Promise<Response>(resolve => { confirmPending = resolve })
        if (url === '/api/desktop/completions/read') {
            const ids = new Set((JSON.parse(String(init?.body)) as { completionIds: string[] }).completionIds)
            done = done.flatMap(item => {
                const completionIds = item.completionIds.filter(id => !ids.has(id))
                return completionIds.length ? [{ ...item, completionIds, count: completionIds.length }] : []
            })
            return Response.json({ marked: ids.size })
        }
        throw new Error(`Unexpected mark-read: ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { container } = await mount(<DesktopActionsInbox />)
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')

    await act(async () => { pillOf(container).click() })
    expect(panelOf(container)).not.toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-actions-inbox-item="question-first"] button[aria-label="Mark as read"]')!.click() })
    expect(labelOf(container)).toBe('Actions: 1 pending · 3 done')
    expect(JSON.parse(String(posts(fetcher)[0][1]?.body))).toEqual({
        items: [{ id: question.id, kind: question.kind, agentId: question.agentId, sessionId: question.sessionId }],
    })
    pending = []
    await act(async () => { confirmPending(Response.json({ marked: 1, failedIds: [] })) })
    expect(labelOf(container)).toBe('Actions: 3 done')

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-actions-inbox-done="done:reviewer:schedule:daily-review"] button[aria-label="Mark as read"]')!.click() })
    expect(JSON.parse(String(posts(fetcher)[1][1]?.body))).toEqual({ completionIds: scheduledRuns })
    expect(labelOf(container)).toBe('Actions: 1 done')
    await act(async () => { pillOf(container).click() })
    expect(panelOf(container)).toBeNull()
    await tick()
    expect(labelOf(container)).toBe('Actions: 1 done')

    pending = [{ ...question, id: 'question-next', summary: 'Which city should I use next?' }]
    done = [doneChat, { ...expandedSchedule, count: 1, sessionIds: ['scheduled-next'], completionIds: [nextScheduledRun] }]
    await tick()
    expect(labelOf(container)).toBe('Actions: 1 pending · 2 done')
    expect(panelOf(container)).toBeNull()
    expect(posts(fetcher)).toHaveLength(2)
})
