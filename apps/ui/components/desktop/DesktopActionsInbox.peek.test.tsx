// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopPendingInboxItem } from '@/lib/desktop/pending-inbox'
import type { DesktopPendingPeek } from '@/lib/desktop/pending-peek'
import { DesktopActionsInbox } from './DesktopActionsInbox'

// The inbox peek on the Mac (upstream #272-#274, #288, #323): a question or an approval is read and
// answered inside the Actions card. Synthetic data only; every request is answered by the stub below.
vi.mock('@rerun/ui/steps', async importOriginal => ({
    ...await importOriginal<typeof import('@rerun/ui/steps')>(),
    StepTransition: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const checkedAt = '2026-11-17T12:00:00.000Z'
const questionId = 'a'.repeat(64), approvalId = 'b'.repeat(64)
const item = (over: Partial<DesktopPendingInboxItem>): DesktopPendingInboxItem => ({ id: questionId, kind: 'question', agentId: 'closer', agentName: 'Closer', agentEnabled: true, sessionId: 'session-deals', title: 'Deal follow-ups', summary: 'How should the follow-ups sound?', updatedAt: '2026-11-17T11:50:00.000Z', ...over })
const asks = item({})
const approves = item({ id: approvalId, kind: 'approval', agentId: 'sender', agentName: 'Sender', sessionId: 'session-mail', title: 'Weekly report', summary: 'Send the weekly report' })
const questionPeek: DesktopPendingPeek = {
    question: { id: questionId, messageId: 'message-1', toolCallId: 'call-question', questions: [{ question: 'How should the follow-ups sound?', options: ['Friendly', 'Formal'] }] },
    approval: null, ask: 'One thing about your tone first.', before: 'I drafted 23 follow-ups.',
}
const approvalPeek: DesktopPendingPeek = {
    question: null, approval: { id: approvalId, messageId: 'message-2', toolCallId: 'call-approval', approvals: [{ action: 'Send the weekly report', detail: 'To: team@northwind.example' }] },
    ask: 'Ready to send.', before: null,
}
const nothing: DesktopPendingPeek = { question: null, approval: null, ask: '', before: null }

type Call = { url: string; method: string; body: unknown }
let root: Root | undefined, container: HTMLDivElement
const calls: Call[] = []
const cancelled: string[] = []
/** The stub server: the two lists the inbox polls, the read-only peek, and the two answer routes. */
function serve({ items, peeks, answer }: { items: () => DesktopPendingInboxItem[]; peeks: Record<string, () => DesktopPendingPeek>; answer?: (call: Call) => Response }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
        calls.push(call)
        if (url === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: checkedAt, nextCursor: null, checkedAt })
        if (url === '/api/desktop/pending-inbox') return Response.json({ items: items(), unavailableAgentIds: [], checkedAt })
        const peek = url.match(/^\/api\/desktop\/sessions\/([^/]+)\/pending-peek$/)
        if (peek && call.method === 'GET') return peeks[peek[1]!] ? Response.json(peeks[peek[1]!]!()) : Response.json({ error: 'Conversation not found' }, { status: 404 })
        if (answer && call.method === 'POST') return answer(call)
        return Response.json({ error: 'Unexpected request' }, { status: 500 })
    }))
}
/** What the question and approval routes send back once the server has taken the answer. */
function accepted(sessionId: string, header: string, id: string, runId: string) {
    const stream = new ReadableStream({ start() {}, cancel() { cancelled.push(sessionId) } })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-session-id': sessionId, 'x-run-id': runId, [header]: id } })
}
async function mount(props: Partial<Parameters<typeof DesktopActionsInbox>[0]> = {}) {
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => { root!.render(<DesktopActionsInbox open {...props} />) })
}
const row = (id: string) => container.querySelector<HTMLElement>(`[data-actions-inbox-item="${id}"]`)
const rows = () => container.querySelectorAll('[data-actions-inbox-item]').length
const peekCard = (id: string) => container.querySelector<HTMLElement>(`[data-actions-inbox-peek="${id}"]`)
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === name || node.textContent?.trim() === name)
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click() }) }
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const writes = () => calls.filter(call => call.method !== 'GET')

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined; calls.length = 0; cancelled.length = 0
    document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

test('a question opens inside the card with the words around it, without answering, marking read or navigating', async () => {
    serve({ items: () => [asks], peeks: { 'session-deals': () => questionPeek } })
    const onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    await mount({ onOpenConversation, onOpenChange })
    await click(row(questionId))
    await settle()

    const card = peekCard(questionId)!
    expect(card.textContent).toContain('Closer')
    expect(card.textContent).toContain('Deal follow-ups')
    expect(card.textContent).toContain('I drafted 23 follow-ups.')
    expect(card.textContent).toContain('One thing about your tone first.')
    expect(card.textContent).toContain('How should the follow-ups sound?')
    expect(card.querySelector('[data-hitl="option-0"]')?.textContent).toContain('Friendly')
    // The list gave way to the request; nothing was sent anywhere, and nothing navigated or folded.
    expect(rows()).toBe(0)
    expect(calls.filter(call => call.url.endsWith('/pending-peek'))).toEqual([{ url: '/api/desktop/sessions/session-deals/pending-peek', method: 'GET', body: undefined }])
    expect(writes()).toEqual([])
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
})

test('the back arrow returns to the list, and a press outside does not lose an open request', async () => {
    serve({ items: () => [asks, approves], peeks: { 'session-deals': () => questionPeek } })
    const onOpenChange = vi.fn()
    await mount({ onOpenChange })
    await click(row(questionId))
    await settle()
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(peekCard(questionId)).not.toBeNull()

    await click(button('Back'))
    expect(peekCard(questionId)).toBeNull()
    expect(rows()).toBe(2)
    expect(writes()).toEqual([])
    // Back on the list, a press outside folds the card as before.
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})

test('an answer goes to the question route of that conversation, shows its receipt, then the card goes away', async () => {
    let pending = true
    serve({
        items: () => (pending ? [asks, approves] : [approves]),
        peeks: { 'session-deals': () => (pending ? questionPeek : nothing), 'session-mail': () => approvalPeek },
        answer: call => { pending = false; return accepted('session-deals', 'x-question-id', questionId, (call.body as { requestId: string }).requestId) },
    })
    const onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    await mount({ onOpenConversation, onOpenChange })
    await click(row(questionId))
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(peekCard(questionId)!.querySelector('[data-hitl="option-0"]'))
    if (writes().length === 0) await click(peekCard(questionId)!.querySelector('[data-hitl="next"]'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // One write, to the same route and with the same payload as the conversation's own card.
    expect(writes()).toHaveLength(1)
    const [sent] = writes()
    expect(sent!.url).toBe('/api/desktop/sessions/session-deals/questions')
    expect(sent!.body).toEqual({ action: 'answer', answers: [['Friendly']], questionId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    // The request was read again right before sending, and the reply's stream was let go.
    expect(calls.filter(call => call.url === '/api/desktop/sessions/session-deals/pending-peek').length).toBeGreaterThanOrEqual(2)
    expect(cancelled).toEqual(['session-deals'])
    expect(peekCard(questionId)!.textContent).toContain('Sent to Closer')
    expect(peekCard(questionId)!.textContent).toContain('Friendly')
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(2600) })
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(onOpenConversation).not.toHaveBeenCalled()
    expect(calls.some(call => call.url === '/api/desktop/pending-inbox/read')).toBe(false)
})

test('an approval is decided through the approval route of its own conversation', async () => {
    serve({
        items: () => [asks, approves], peeks: { 'session-deals': () => questionPeek, 'session-mail': () => approvalPeek },
        answer: call => accepted('session-mail', 'x-approval-id', approvalId, (call.body as { requestId: string }).requestId),
    })
    await mount()
    await click(row(approvalId))
    await settle()
    expect(peekCard(approvalId)!.textContent).toContain('To: team@northwind.example')
    await click(peekCard(approvalId)!.querySelector('[data-hitl="approve"]'))
    await settle()

    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.url).toBe('/api/desktop/sessions/session-mail/approvals')
    expect(writes()[0]!.body).toEqual({ approvalId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), decisions: [{ decision: 'approved' }] })
    expect(peekCard(approvalId)!.textContent).toContain('Sent to Sender')
})

test('a request answered elsewhere while the card stayed open is not answered again', async () => {
    let pending = true
    serve({ items: () => [asks], peeks: { 'session-deals': () => (pending ? questionPeek : nothing) }, answer: () => { throw new Error('must not be reached') } })
    await mount()
    await click(row(questionId))
    await settle()
    pending = false
    await click(peekCard(questionId)!.querySelector('[data-hitl="option-0"]'))
    if (writes().length === 0 && peekCard(questionId)!.querySelector('[data-hitl="next"]')) await click(peekCard(questionId)!.querySelector('[data-hitl="next"]'))
    await settle()
    expect(writes()).toEqual([])
    expect(peekCard(questionId)!.textContent).toContain('This was already answered.')
    expect(peekCard(questionId)!.querySelector('[data-hitl="option-0"]')).toBeNull()
})

test('a coworker still busy keeps the request and says so; a refusal that is not confirmed is a failure', async () => {
    let reply = () => Response.json({ error: 'A run is in flight' }, { status: 409 })
    serve({ items: () => [asks], peeks: { 'session-deals': () => questionPeek }, answer: () => reply() })
    await mount()
    await click(row(questionId))
    await settle()
    const answer = async () => {
        await click(peekCard(questionId)!.querySelector('[data-hitl="option-0"]'))
        if (peekCard(questionId)!.querySelector('[data-hitl="next"]')) await click(peekCard(questionId)!.querySelector('[data-hitl="next"]'))
        await settle()
    }
    await answer()
    expect(peekCard(questionId)!.querySelector('[role="alert"]')?.textContent).toBe('Closer is still working. Try again in a moment.')
    expect(peekCard(questionId)!.querySelector('[data-hitl="option-0"]')).not.toBeNull()

    // A 200 that does not name this conversation and question is not taken as sent.
    reply = () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'x-session-id': 'another-session', 'x-run-id': 'run', 'x-question-id': questionId } })
    await answer()
    expect(peekCard(questionId)!.querySelector('[role="alert"]')?.textContent).toBe('Your answer did not go through. Try again.')
    expect(peekCard(questionId)!.textContent).not.toContain('Sent to Closer')
})

test('a request the card cannot answer offers the conversation, which opens the exact chat', async () => {
    // A held connector call is listed as an approval, yet it is not the approval card's request.
    const held = item({ id: 'held-call', kind: 'approval', summary: 'Allow Gmail Send Email?' })
    serve({ items: () => [held], peeks: { 'session-deals': () => nothing } })
    const onOpenConversation = vi.fn(), onOpenChange = vi.fn()
    await mount({ onOpenConversation, onOpenChange })
    await click(row('held-call'))
    await settle()
    expect(peekCard('held-call')!.textContent).toContain('Open the conversation to answer.')
    await click(button('Open conversation'))
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ id: 'session-deals', agentId: 'closer', agentName: 'Closer', title: 'Deal follow-ups' })
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(writes()).toEqual([])
})

test('any other kind of request still opens its conversation directly', async () => {
    const secret = item({ id: 'secret-1', kind: 'secret', summary: 'Needs API token' })
    serve({ items: () => [secret], peeks: {} })
    const onOpenConversation = vi.fn()
    await mount({ onOpenConversation })
    await click(row('secret-1'))
    expect(peekCard('secret-1')).toBeNull()
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith({ id: 'session-deals', agentId: 'closer', agentName: 'Closer', title: 'Deal follow-ups' })
    expect(calls.some(call => call.url.endsWith('/pending-peek'))).toBe(false)
})

test('a long inbox mounts its first screen with the card and the rest once it has opened', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const many = Array.from({ length: 60 }, (_, index) => item({ id: `q-${index}`, sessionId: `session-${index}`, updatedAt: new Date(Date.parse('2026-11-17T11:00:00.000Z') - index * 60_000).toISOString() }))
    serve({ items: () => many, peeks: {} })
    await mount()
    expect(rows()).toBe(12)
    // The newest rows come first, and the header already counts every request.
    expect(row('q-0')).not.toBeNull()
    expect(container.textContent).toContain('60 pending')
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(rows()).toBe(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(rows()).toBe(60)
})

test('a short inbox mounts whole at once', async () => {
    serve({ items: () => [asks, approves], peeks: {} })
    await mount()
    expect(rows()).toBe(2)
})
