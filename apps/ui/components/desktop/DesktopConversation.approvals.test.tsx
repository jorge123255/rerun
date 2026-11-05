// @vitest-environment happy-dom
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { DesktopApprovalAnswer, DesktopPendingApproval } from '@/lib/desktop/approvals'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'
import type { DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { DesktopConversation, type ComposerDraft } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = vi.hoisted(() => ({ messages: [] as UIMessage[], status: 'ready', error: undefined as Error | undefined, sendMessage: vi.fn(), stop: vi.fn(), setMessages: vi.fn(), clearError: vi.fn() }))
let transportFetch: typeof fetch
vi.mock('@ai-sdk/react', () => ({ useChat: ({ transport }: { transport: { fetch: typeof fetch } }) => { transportFetch = transport.fetch; return chat } }))
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (ready: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))
// Exercise the real cards while keeping Web Animations out of happy-dom's teardown.
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => {
        if (!elements.has(tag)) elements.set(tag, plain(tag))
        return elements.get(tag)!
    }
    return { ...actual,
        AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
        motion: new Proxy(actual.motion, { get(target, key, receiver) {
            if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
            return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
        } }),
    }
})

const agent = { id: 'agent', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
const approval: DesktopPendingApproval = {
    id: 'a'.repeat(64), messageId: 'approval-message', toolCallId: 'approval-tool',
    approvals: [{ action: 'Send the draft', detail: 'To: colleague@example.test\nDraft text.' }],
}
const question: DesktopPendingQuestion = { id: 'c'.repeat(64), messageId: 'question-message', toolCallId: 'question-tool', questions: [{ question: 'Which version?', options: ['Latest'] }] }
const approvals = new Map<string, DesktopPendingApproval | null>()
const questions = new Map<string, DesktopPendingQuestion | null>()
const queues = new Map<string, DesktopQueuedMessage>()
const approvalPosts: { sessionId: string; body: DesktopApprovalAnswer }[] = []
const questionPosts: { sessionId: string; body: DesktopQuestionAnswer }[] = []
const normalPosts: Record<string, unknown>[] = []
const onChatSession = vi.fn()
let root: Root, container: HTMLDivElement
let readApproval: (sessionId: string) => Promise<Response>
let decide: (sessionId: string, body: DesktopApprovalAnswer) => Promise<Response>
let answer: (sessionId: string, body: DesktopQuestionAnswer) => Promise<Response>

function acknowledgement(sessionId: string, requestId: string, name: string, id: string) {
    return new Response('data: [DONE]\n\n', { headers: {
        'content-type': 'text/event-stream', 'x-session-id': sessionId, 'x-run-id': requestId, [name]: id,
    } })
}

beforeEach(() => {
    approvals.clear(); approvals.set('one', approval); questions.clear(); queues.clear()
    approvalPosts.length = 0; questionPosts.length = 0; normalPosts.length = 0
    chat.status = 'ready'; chat.error = undefined; chat.messages = []
    chat.sendMessage.mockReset(); chat.setMessages.mockReset(); onChatSession.mockReset()
    chat.clearError.mockImplementation(() => { chat.error = undefined })
    readApproval = async sessionId => Response.json({ approval: approvals.get(sessionId) ?? null })
    decide = async (sessionId, body) => { approvals.set(sessionId, null); return acknowledgement(sessionId, body.requestId, 'x-approval-id', body.approvalId) }
    answer = async (sessionId, body) => { questions.set(sessionId, null); return acknowledgement(sessionId, body.requestId, 'x-question-id', body.questionId) }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local'), sessionId = url.pathname.split('/')[4]
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) {
            if (init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as DesktopApprovalAnswer
                approvalPosts.push({ sessionId, body })
                return decide(sessionId, body)
            }
            return readApproval(sessionId)
        }
        if (url.pathname.endsWith('/questions')) {
            if (init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as DesktopQuestionAnswer
                questionPosts.push({ sessionId, body })
                return answer(sessionId, body)
            }
            return Response.json({ question: questions.get(sessionId) ?? null })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.pathname.endsWith('/feedback')) return Response.json({ votes: [] })
        if (url.pathname.endsWith('/stop')) return Response.json({ running: false, runId: null, failedRunId: null })
        if (url.pathname.endsWith('/queue')) {
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body)), key = body.scope.sessionId ?? body.scope.tabUid
                const current = queues.get(key)
                if (body.action === 'enqueue') queues.set(key, body.item)
                else if (current?.id === body.id && body.action === 'remove') queues.delete(key)
                else if (current && current.id === body.id) queues.set(key, { ...current, state: body.action === 'attempt' ? 'sending' : 'review' })
                return Response.json({ queued: queues.get(key) ?? null })
            }
            return Response.json({ queued: queues.get(url.searchParams.get('sessionId') ?? url.searchParams.get('tabUid')!) ?? null })
        }
        if (url.pathname === '/api/desktop/chat') {
            const body = JSON.parse(String(init?.body)); normalPosts.push(body)
            return acknowledgement(body.sessionId, body.requestId ?? 'normal-run', 'x-unused', 'unused')
        }
        const background = desktopBackgroundRead(input, init); if (background) return background
        throw new Error('Unexpected request: ' + url.pathname)
    }))
    chat.sendMessage.mockImplementation(async (message: { text: string }, options: { body: object }) => {
        try {
            // The actual request wrapper must replace the SDK's serialized decision text.
            const response = await transportFetch('/api/desktop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...options.body, text: message.text }) })
            await response.text()
        } catch (cause) {
            // Match the SDK's swallowed transport rejection: the receipt check must still fail.
            chat.error = cause instanceof Error ? cause : new Error('Send failed')
            chat.status = 'error'
        }
    })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})

afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); vi.unstubAllGlobals() })
const render = (sessionId = 'one', initialDraft?: ComposerDraft, active = true) => act(async () => {
    root.render(<DesktopConversation agent={agent} sessionId={sessionId} sessions={[]} initialDraft={initialDraft} active={active} onChatSession={onChatSession} onSelectSession={() => {}} />)
})
const button = (label: string) => [...container.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)!
const click = async (label: string) => {
    expect(button(label), label).toBeDefined()
    await act(async () => { button(label).click() })
}
const composer = () => container.querySelector<HTMLTextAreaElement>('#desktop-message')!
const note = (value: string) => act(async () => {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Why not? (optional)"]')!
    expect(textarea).not.toBeNull()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
})
const savedQueue = (): DesktopQueuedMessage => ({ id: crypto.randomUUID(), text: 'Saved follow-up', createdAt: Date.now(), behindRunId: null, state: 'waiting' })

test('the original batch approves and declines with a note in one indexed request while keeping the ordinary draft', async () => {
    approvals.set('one', { ...approval, approvals: [...approval.approvals, { action: 'Publish the post', detail: '# Announcement' }] })
    await render('one', { text: 'A separate draft to keep', attachment: 'brief.md' })
    expect(composer().form!.hidden).toBe(true)
    await click('Approve')
    expect(approvalPosts).toHaveLength(0)
    expect(container.textContent).toContain('Publish the post')
    await click('Not now'); await note('  Wait for my review.  '); await click('Confirm')
    expect(approvalPosts).toEqual([{ sessionId: 'one', body: { approvalId: approval.id, requestId: expect.any(String), decisions: [
        { decision: 'approved' }, { decision: 'declined', note: 'Wait for my review.' },
    ] } }])
    expect(questionPosts).toHaveLength(0)
    expect(normalPosts).toHaveLength(0)
    expect(composer().value).toBe('A separate draft to keep')
    expect(composer().form!.hidden).toBe(false)
    expect(button('Remove attachment brief.md')).toBeDefined()
    expect(onChatSession).toHaveBeenCalledWith('one', undefined)
})

test('a lost acknowledgement restores immutable saved decisions and retries the same UUID after the SDK swallows the error', async () => {
    decide = async (sessionId, body) => {
        if (approvalPosts.length === 1) {
            approvals.set(sessionId, { ...approval, attempt: { requestId: body.requestId, decisions: body.decisions } })
            throw new Error('Approval acknowledgement lost')
        }
        approvals.set(sessionId, null)
        return acknowledgement(sessionId, body.requestId, 'x-approval-id', body.approvalId)
    }
    await render('one', { text: 'Keep my draft' })
    await click('Not now'); await note('Do not send yet.'); await click('Confirm')
    expect(approvalPosts).toHaveLength(1)
    expect(container.querySelector('[data-hitl="approve"]')).toBeNull()
    expect(container.textContent).toContain('Do not send yet.')
    await click('Retry decisions')
    expect(approvalPosts).toHaveLength(2)
    expect(approvalPosts[1]).toEqual(approvalPosts[0])
    expect(normalPosts).toHaveLength(0)
    expect(questionPosts).toHaveLength(0)
    expect(composer().value).toBe('Keep my draft')
    expect(composer().form!.hidden).toBe(false)
})

test('an acknowledgement for the question route cannot accept approval decisions', async () => {
    decide = async (sessionId, body) => acknowledgement(sessionId, body.requestId, 'x-question-id', body.approvalId)
    await render('one', { text: 'Unsent draft' })
    await click('Approve')
    expect(onChatSession).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not confirm')
    expect(button('Retry decisions')).toBeDefined()
    expect(composer().value).toBe('Unsent draft')
    expect(composer().form!.hidden).toBe(true)
    decide = async (sessionId, body) => { approvals.set(sessionId, null); return acknowledgement(sessionId, body.requestId, 'x-approval-id', body.approvalId) }
    await click('Retry decisions')
    expect(approvalPosts[1]).toEqual(approvalPosts[0])
    expect(onChatSession).toHaveBeenCalledTimes(1)
})

test('a stale approval read from another chat cannot replace or decide the active chat’s action', async () => {
    const second = { ...approval, id: 'b'.repeat(64), messageId: 'second-message', toolCallId: 'second-tool', approvals: [{ action: 'Second chat action' }] }
    approvals.set('two', second)
    let release!: (response: Response) => void
    readApproval = sessionId => sessionId === 'one' ? new Promise<Response>(resolve => { release = resolve }) : Promise.resolve(Response.json({ approval: approvals.get(sessionId) ?? null }))
    await render('one'); await render('two')
    await act(async () => { release(Response.json({ approval })) })
    expect(container.textContent).not.toContain(approval.approvals[0].action)
    expect(container.textContent).toContain(second.approvals[0].action)
    await render('two', undefined, false)
    await click('Approve')
    expect(approvalPosts).toHaveLength(0)
    await render('two', undefined, true)
    await click('Approve')
    expect(approvalPosts).toEqual([{ sessionId: 'two', body: { approvalId: second.id, requestId: expect.any(String), decisions: [{ decision: 'approved' }] } }])
})

test('an unknown approval read holds the ordinary composer and queued Send now until the pending request is shown', async () => {
    const queued = savedQueue(); queues.set('one', queued)
    let release!: (response: Response) => void
    readApproval = () => new Promise<Response>(resolve => { release = resolve })
    await render('one', { text: 'Keep the newer draft' })
    expect(button('Send').disabled).toBe(true)
    expect(button('Send queued message now').disabled).toBe(true)
    await click('Send queued message now')
    await act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(normalPosts).toHaveLength(0)
    await act(async () => { release(Response.json({ approval })) })
    expect(container.querySelector('[data-hitl="approve"]')).not.toBeNull()
    expect(button('Send queued message now').disabled).toBe(true)
    expect(queues.get('one')?.id).toBe(queued.id)
    expect(normalPosts).toHaveLength(0)
})

test('a question-to-approval transition holds queued and ordinary messages throughout the approval reload', async () => {
    approvals.set('one', null); questions.set('one', question)
    const queued = savedQueue(); queues.set('one', queued)
    let release!: (response: Response) => void
    answer = async (sessionId, body) => {
        questions.set(sessionId, null); approvals.set(sessionId, approval)
        readApproval = () => new Promise<Response>(resolve => { release = resolve })
        return acknowledgement(sessionId, body.requestId, 'x-question-id', body.questionId)
    }
    await render('one', { text: 'A separate conversation draft' })
    await act(async () => { container.querySelector<HTMLElement>('[data-hitl="option-0"]')!.click() })
    expect(questionPosts).toHaveLength(1)
    expect(button('Send').disabled).toBe(true)
    expect(button('Send queued message now').disabled).toBe(true)
    await click('Send queued message now')
    await act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(normalPosts).toHaveLength(0)
    readApproval = async sessionId => Response.json({ approval: approvals.get(sessionId) ?? null })
    await act(async () => { release(Response.json({ approval })) })
    expect(container.querySelector('[data-hitl="option-0"]')).toBeNull()
    expect(container.querySelector('[data-hitl="approve"]')).not.toBeNull()
    expect(button('Send queued message now').disabled).toBe(true)
    expect(approvalPosts).toHaveLength(0)
    expect(queues.get('one')?.id).toBe(queued.id)
    expect(composer().value).toBe('A separate conversation draft')
    expect(normalPosts).toHaveLength(0)
})

test('an inconsistent question-and-approval snapshot blocks dispatch and retries the current request', async () => {
    questions.set('one', question)
    await render('one', { text: 'Draft awaiting the current request' })
    expect(container.textContent).toContain('This conversation changed while loading')
    expect(container.querySelector('[data-hitl]')).toBeNull()
    expect(button('Send').disabled).toBe(true)
    await act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(normalPosts).toHaveLength(0)
    questions.set('one', null)
    await click('Retry conversation')
    expect(container.querySelector('[data-hitl="approve"]')).not.toBeNull()
    expect(approvalPosts).toHaveLength(0)
    expect(questionPosts).toHaveLength(0)
    expect(composer().value).toBe('Draft awaiting the current request')
})
