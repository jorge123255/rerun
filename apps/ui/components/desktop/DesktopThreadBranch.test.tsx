// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopPendingPeek } from '@/lib/desktop/pending-peek'
import type { DesktopSessionView } from './DesktopApp'
import { DesktopThreadBranch, DesktopThreadPeeksContext, type DesktopThreadPeeks } from './DesktopThreadBranch'

// A thread of General that needs the person unfolds into its request (upstream #334, #342).
// Synthetic data only; the stub below stands for the Mac's local routes.
vi.mock('motion/react', async () => {
    const { createElement: h, forwardRef } = await import('react')
    const strip = ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...rest }: Record<string, unknown>) => rest
    const div = forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => h('div', { ...strip(props), ref }))
    return { AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: { div }, useReducedMotion: () => true }
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const questionId = 'a'.repeat(64), nextQuestionId = 'c'.repeat(64)
const thread: DesktopSessionView = { id: 'thread-tone', agentId: 'closer', kind: 'thread', title: 'Tone of the follow-ups', firstMessage: 'Follow up on my deals', createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:05:00.000Z' }
const peekOf = (id: string, question: string, options: string[]): DesktopPendingPeek => ({
    question: { id, messageId: `message-${id.slice(0, 4)}`, toolCallId: `call-${id.slice(0, 4)}`, questions: [{ question, options }] },
    approval: null, ask: 'One thing about your tone first.', before: null,
})
const owner = (waiting: [string, { kind: string; id: string }][] = [[thread.id, { kind: 'question', id: questionId }]]): DesktopThreadPeeks =>
    ({ agentId: 'closer', agentName: 'Closer', agentEnabled: true, waiting: new Map(waiting) })

type Call = { url: string; method: string; body: unknown }
let root: Root | undefined, container: HTMLDivElement
const calls: Call[] = []
function serve(peek: () => DesktopPendingPeek, answer?: (call: Call) => Response) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
        calls.push(call)
        if (url === `/api/desktop/sessions/${thread.id}/pending-peek` && call.method === 'GET') return Response.json(peek())
        if (answer && call.method === 'POST') return answer(call)
        return Response.json({ error: 'Unexpected request' }, { status: 500 })
    }))
}
async function mount(peeks: DesktopThreadPeeks | null, onOpen = vi.fn(), needsYou = true) {
    if (!root) { container = document.body.appendChild(document.createElement('div')); root = createRoot(container) }
    await act(async () => {
        root!.render(<DesktopThreadPeeksContext.Provider value={peeks}><DesktopThreadBranch thread={thread} needsYou={needsYou} onOpen={onOpen} /></DesktopThreadPeeksContext.Provider>)
    })
    await act(async () => { await Promise.resolve() })
    return onOpen
}
const rowButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(thread.title))!
const body = () => container.querySelector<HTMLElement>(`[data-thread-peek="${thread.id}"]`)
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click() }) }
const reads = () => calls.filter(call => call.url.endsWith('/pending-peek')).length
const writes = () => calls.filter(call => call.method !== 'GET')

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined; calls.length = 0
    document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

test('a row that waits on a question unfolds into it instead of opening the thread, and folds back', async () => {
    serve(() => peekOf(questionId, 'How should the follow-ups sound?', ['Friendly', 'Formal']))
    const onOpen = await mount(owner())
    // The request is read as soon as the row waits; reading sends nothing.
    expect(reads()).toBe(1)
    expect(rowButton().getAttribute('aria-expanded')).toBe('false')
    expect(rowButton().textContent).toContain('Needs you')
    expect(body()).toBeNull()

    await click(rowButton())
    expect(rowButton().getAttribute('aria-expanded')).toBe('true')
    expect(body()!.textContent).toContain('One thing about your tone first.')
    expect(body()!.textContent).toContain('How should the follow-ups sound?')
    expect(body()!.querySelector('[data-hitl="option-1"]')?.textContent).toContain('Formal')
    expect(onOpen).not.toHaveBeenCalled()
    expect(writes()).toEqual([])

    await click(rowButton())
    expect(body()).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
})

test('the answer goes to that thread, the receipt shows, then the row folds without its badge', async () => {
    let waiting = true
    serve(() => (waiting ? peekOf(questionId, 'How should the follow-ups sound?', ['Friendly', 'Formal']) : { question: null, approval: null, ask: '', before: null }), call => {
        waiting = false
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'x-session-id': thread.id, 'x-run-id': (call.body as { requestId: string }).requestId, 'x-question-id': questionId } })
    })
    const onOpen = await mount(owner())
    await click(rowButton())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(body()!.querySelector('[data-hitl="option-1"]'))
    if (writes().length === 0) await click(body()!.querySelector('[data-hitl="next"]'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.url).toBe(`/api/desktop/sessions/${thread.id}/questions`)
    expect(writes()[0]!.body).toEqual({ action: 'answer', answers: [['Formal']], questionId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(body()!.textContent).toContain('Sent to Closer')
    expect(rowButton().textContent).not.toContain('Needs you')

    // The coworker works again: the list stops naming the thread while the receipt is still up.
    await mount(owner([]), onOpen, false)
    expect(body()!.textContent).toContain('Sent to Closer')
    await act(async () => { await vi.advanceTimersByTimeAsync(2600) })
    expect(body()).toBeNull()
    expect(rowButton().textContent).not.toContain('Needs you')
    // A row that waits on nothing opens its thread again.
    await click(rowButton())
    expect(onOpen).toHaveBeenCalledOnce()
})

test('the footer of an unfolded row opens the thread', async () => {
    serve(() => peekOf(questionId, 'How should the follow-ups sound?', ['Friendly', 'Formal']))
    const onOpen = await mount(owner())
    await click(rowButton())
    await click([...body()!.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Open conversation'))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(body()).toBeNull()
    expect(writes()).toEqual([])
})

test('a new request on the same row is read again and replaces the one shown', async () => {
    let current = peekOf(questionId, 'How should the follow-ups sound?', ['Friendly', 'Formal'])
    serve(() => current)
    const onOpen = await mount(owner())
    await click(rowButton())
    expect(body()!.textContent).toContain('How should the follow-ups sound?')

    current = peekOf(nextQuestionId, 'Send them today?', ['Yes', 'Tomorrow'])
    await mount(owner([[thread.id, { kind: 'question', id: nextQuestionId }]]), onOpen)
    expect(reads()).toBe(2)
    expect(body()!.textContent).toContain('Send them today?')
    expect(body()!.textContent).not.toContain('How should the follow-ups sound?')
})

test('a row that needs the person for anything else, and a row with no owner, open the thread as before', async () => {
    serve(() => peekOf(questionId, 'unused', ['a', 'b']))
    const onOpen = await mount(owner([[thread.id, { kind: 'secret', id: 'secret-1' }]]))
    expect(rowButton().hasAttribute('aria-expanded')).toBe(false)
    await click(rowButton())
    expect(onOpen).toHaveBeenCalledOnce()

    await mount(null, onOpen)
    await click(rowButton())
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(body()).toBeNull()
    expect(calls).toEqual([])
})
