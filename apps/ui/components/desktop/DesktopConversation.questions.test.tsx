// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'
import type { DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { DesktopConversation, type ComposerDraft } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = vi.hoisted(() => ({ messages: [] as UIMessage[], status: 'ready', error: undefined as Error | undefined, sendMessage: vi.fn(), stop: vi.fn(), setMessages: vi.fn(), clearError: vi.fn() }))
let transportFetch: typeof fetch
vi.mock('@ai-sdk/react', () => ({ useChat: ({ transport }: { transport: { fetch: typeof fetch } }) => { transportFetch = transport.fetch; return chat } }))
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (ready: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))

const agent = { id: 'agent', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
const question: DesktopPendingQuestion = {
    id: 'a'.repeat(64), messageId: 'question-message', toolCallId: 'ask-color',
    questions: [{ question: 'Which color should I use?', options: ['Blue', 'Red'] }],
}
const firstRun = 'first-run'
const questions = new Map<string, DesktopPendingQuestion | null>()
const queues = new Map<string, DesktopQueuedMessage>()
const questionPosts: { sessionId: string; body: DesktopQuestionAnswer }[] = []
const normalPosts: Record<string, unknown>[] = []
let root: Root, container: HTMLDivElement, running: boolean, streamAfterSend: boolean
let readQuestion: (sessionId: string) => Promise<Response>
let answerQuestion: (sessionId: string, body: DesktopQuestionAnswer) => Promise<Response>
const onChatSession = vi.fn()

function acceptedAnswer(sessionId: string, body: DesktopQuestionAnswer) {
    return new Response('data: [DONE]\n\n', { headers: {
        'content-type': 'text/event-stream', 'x-session-id': sessionId,
        'x-question-id': body.questionId, 'x-run-id': body.requestId,
    } })
}

beforeEach(() => {
    questions.clear(); questions.set('one', question); queues.clear(); questionPosts.length = 0; normalPosts.length = 0
    running = false; streamAfterSend = false
    chat.messages = []; chat.status = 'ready'; chat.error = undefined
    chat.sendMessage.mockReset(); chat.setMessages.mockReset(); chat.stop.mockReset(); onChatSession.mockReset()
    chat.clearError.mockImplementation(() => { chat.error = undefined })
    chat.stop.mockImplementation(() => { chat.status = 'ready' })
    readQuestion = async sessionId => Response.json({ question: questions.get(sessionId) ?? null })
    answerQuestion = async (sessionId, body) => { questions.set(sessionId, null); return acceptedAnswer(sessionId, body) }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        const sessionId = url.pathname.split('/')[4]
        if (url.pathname.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) {
            if (init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as DesktopQuestionAnswer
                questionPosts.push({ sessionId, body })
                return answerQuestion(sessionId, body)
            }
            return readQuestion(sessionId)
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.pathname.endsWith('/feedback')) return Response.json({ votes: [] })
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
        if (url.pathname.endsWith('/stop')) {
            if (init?.method === 'POST') { running = false; return Response.json({ canceled: 1, alreadyFinished: false }) }
            return Response.json({ running, runId: running ? firstRun : null, failedRunId: null })
        }
        if (url.pathname === '/api/desktop/chat') {
            const body = JSON.parse(String(init?.body)); normalPosts.push(body)
            return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId, 'x-run-id': body.requestId ?? firstRun } })
        }
        throw new Error('Unexpected request: ' + url.pathname)
    }))
    chat.sendMessage.mockImplementation(async (message: { text: string }, options: { body: object }) => {
        if (streamAfterSend) chat.status = 'streaming'
        try {
            // Include the serialized SDK text so the question transport must replace, rather
            // than merge, this ordinary-chat envelope with the indexed answer payload.
            const response = await transportFetch('/api/desktop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...options.body, text: message.text }) })
            await response.text()
        } catch (cause) {
            // The SDK reports transport failures through its error state. The answer handler
            // must still reject when no verified acknowledgement reached sendToEngine.
            chat.error = cause instanceof Error ? cause : new Error('Send failed')
            chat.status = 'error'
        }
    })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})

afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove(); vi.unstubAllGlobals(); vi.useRealTimers()
})

const render = (sessionId = 'one', initialDraft?: ComposerDraft, active = true) => act(async () => {
    root.render(<DesktopConversation agent={agent} sessionId={sessionId} sessions={[]} initialDraft={initialDraft} active={active} onChatSession={onChatSession} onSelectSession={() => {}} />)
})
const button = (label: string) => [...container.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)!
const click = async (label: string) => {
    expect(button(label), label).toBeDefined()
    await act(async () => { button(label).click() })
}
const choose = async (index = 0) => {
    const option = container.querySelector<HTMLElement>(`[data-hitl="option-${index}"]`)
    expect(option).not.toBeNull()
    await act(async () => { option!.click() })
}
const composer = () => container.querySelector<HTMLTextAreaElement>('#desktop-message')!
const typeDraft = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text)
    composer().dispatchEvent(new Event('input', { bubbles: true }))
})
const queueItem = (): DesktopQueuedMessage => ({ id: crypto.randomUUID(), text: 'Saved follow-up', createdAt: Date.now(), behindRunId: firstRun, state: 'waiting' })

test('loads the saved original question form, sends only indexed answers to its route and preserves the ordinary draft', async () => {
    await render('one', { text: 'My separate draft', attachment: 'notes.md' })
    expect(container.textContent).toContain(question.questions[0].question)
    expect(composer().form!.hidden).toBe(true)
    await act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(chat.sendMessage).not.toHaveBeenCalled()
    await choose()
    expect(questionPosts).toEqual([{ sessionId: 'one', body: { questionId: question.id, requestId: expect.any(String), action: 'answer', answers: [['Blue']] } }])
    expect(normalPosts).toHaveLength(0)
    expect(composer().value).toBe('My separate draft')
    expect(composer().form!.hidden).toBe(false)
    expect(button('Remove attachment notes.md')).toBeDefined()
    expect(onChatSession).toHaveBeenCalledWith('one', undefined)
})

test('a newly pending question rejects an ordinary send without losing its typed draft', async () => {
    questions.set('one', null)
    const draft = 'Keep this message while I answer your question'
    await render('one', { text: draft })
    expect(composer().form!.hidden).toBe(false)
    expect(button('Send').disabled).toBe(false)
    const originalFetch = globalThis.fetch
    let rejectSend!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/desktop/chat' && init?.method === 'POST') {
            normalPosts.push(JSON.parse(String(init.body)))
            return new Promise<Response>(resolve => { rejectSend = resolve })
        }
        return originalFetch(input, init)
    }))
    streamAfterSend = true
    await click('Send')
    await render()
    expect(composer().value).toBe(draft)
    await act(async () => {
        questions.set('one', question)
        rejectSend(Response.json({ error: 'Answer or dismiss the pending question before sending another message.' }, { status: 409 }))
    })
    await render()
    expect(normalPosts).toHaveLength(1)
    expect(normalPosts[0]).toMatchObject({ sessionId: 'one', text: draft })
    expect(questionPosts).toHaveLength(0)
    expect(onChatSession).not.toHaveBeenCalled()
    expect(container.textContent).toContain(question.questions[0].question)
    expect(container.textContent).toContain('Answer or dismiss the pending question')
    expect(composer().form!.hidden).toBe(true)
    expect(composer().value).toBe(draft)
})

test('holds manual and automatic queued sends while a saved question waits for an answer', async () => {
    const queued = queueItem(); queues.set('one', queued); running = true
    await render('one', { text: 'Keep my newer draft' })
    expect(button('Send queued message now').disabled).toBe(true)
    await click('Send queued message now')
    running = false; chat.status = 'streaming'; await render(); chat.status = 'ready'; await render()
    expect(button('Send queued message now').disabled).toBe(true)
    await click('Send queued message now')
    expect(normalPosts).toHaveLength(0)
    expect(questionPosts).toHaveLength(0)
    expect(queues.get('one')?.id).toBe(queued.id)
    expect(composer().value).toBe('Keep my newer draft')
})

test('an unresolved question read holds ordinary sending and queue dispatch until the saved state is known', async () => {
    const queued = queueItem(); queues.set('one', queued)
    let resolve!: (response: Response) => void
    readQuestion = () => new Promise<Response>(done => { resolve = done })
    await render('one', { text: 'Do not bypass the question' })
    expect(button('Send').disabled).toBe(true)
    expect(button('Send queued message now').disabled).toBe(true)
    await click('Send queued message now')
    await act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(normalPosts).toHaveLength(0)
    await act(async () => { resolve(Response.json({ question })) })
    expect(container.querySelector('[data-hitl="option-0"]')).not.toBeNull()
    expect(normalPosts).toHaveLength(0)
})

test('a lost answer acknowledgement restores the saved intent and retries the same UUID exactly once', async () => {
    answerQuestion = async (sessionId, body) => {
        if (questionPosts.length === 1) {
            questions.set(sessionId, { ...question, attempt: body.action === 'answer'
                ? { action: 'answer', requestId: body.requestId, answers: body.answers }
                : { action: 'cancel', requestId: body.requestId } })
            throw new Error('Answer acknowledgement lost')
        }
        questions.set(sessionId, null)
        return acceptedAnswer(sessionId, body)
    }
    await render('one', { text: 'Keep this draft' })
    await choose()
    expect(questionPosts).toHaveLength(1)
    expect(container.querySelector('[data-hitl="option-0"]')).toBeNull()
    expect(button('Retry answer')).toBeDefined()
    expect(container.textContent).toContain('Blue')
    await click('Retry answer')
    expect(questionPosts).toHaveLength(2)
    expect(questionPosts[1]).toEqual(questionPosts[0])
    expect(normalPosts).toHaveLength(0)
    expect(composer().value).toBe('Keep this draft')
    expect(composer().form!.hidden).toBe(false)
})

test('switching chats ignores the old question read and can answer only the visible chat', async () => {
    const second = { ...question, id: 'b'.repeat(64), messageId: 'message-two', toolCallId: 'tool-two', questions: [{ question: 'Second chat question?', options: ['Second answer'] }] }
    questions.set('two', second)
    let resolveFirst!: (response: Response) => void
    readQuestion = sessionId => sessionId === 'one' ? new Promise<Response>(done => { resolveFirst = done }) : Promise.resolve(Response.json({ question: questions.get(sessionId) ?? null }))
    await render('one')
    await render('two')
    await act(async () => { resolveFirst(Response.json({ question })) })
    expect(container.textContent).not.toContain(question.questions[0].question)
    expect(container.textContent).toContain(second.questions[0].question)
    await choose()
    expect(questionPosts).toEqual([{ sessionId: 'two', body: { action: 'answer', answers: [['Second answer']], questionId: second.id, requestId: expect.any(String) } }])
    expect(normalPosts).toHaveLength(0)
})

test('an inactive tab cannot answer its still-mounted question', async () => {
    await render()
    await render('one', undefined, false)
    await choose()
    await click('Dismiss questions')
    expect(questionPosts).toHaveLength(0)
    await render('one', undefined, true)
    await choose()
    expect(questionPosts).toHaveLength(1)
})

test('streaming with unknown question state still allows enqueue and Stop, but holds flushing for the refreshed question', async () => {
    questions.set('one', null)
    streamAfterSend = true
    await render('one', { text: 'Start the long reply' })
    await click('Send')
    expect(normalPosts).toHaveLength(1)
    await typeDraft('Run this after the reply')
    expect(button('Send').disabled).toBe(false)
    await click('Send')
    const queued = queues.get('one')!
    expect(queued.text).toBe('Run this after the reply')
    let resolve!: (response: Response) => void
    readQuestion = () => new Promise<Response>(done => { resolve = done })
    streamAfterSend = false
    await click('Send queued message now')
    expect(chat.stop).toHaveBeenCalledTimes(1)
    expect(normalPosts).toHaveLength(1)
    expect(queues.get('one')?.id).toBe(queued.id)
    readQuestion = async () => Response.json({ question: null })
    await act(async () => { resolve(Response.json({ question: null })) })
    expect(normalPosts).toHaveLength(2)
    expect(normalPosts[1]).toMatchObject({ sessionId: 'one', requestId: queued.id, text: queued.text })
})

test.each([false, true])('an accepted answer stream allows enqueue and then a normal queued send (Send now: %s)', async sendNow => {
    let finish!: () => void
    answerQuestion = async (sessionId, body) => {
        questions.set(sessionId, null)
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            finish = () => controller.close()
        } })
        return new Response(stream, { headers: {
            'content-type': 'text/event-stream', 'x-session-id': sessionId,
            'x-question-id': body.questionId, 'x-run-id': body.requestId,
        } })
    }
    streamAfterSend = true
    await render('one', { text: 'Follow up after the answered question' })
    await choose()
    expect(questionPosts).toHaveLength(1)
    expect(composer().form!.hidden).toBe(false)
    expect(button('Send').disabled).toBe(false)
    await click('Send')
    const queued = queues.get('one')!
    expect(queued).toMatchObject({ text: 'Follow up after the answered question', behindRunId: questionPosts[0].body.requestId })
    expect(questionPosts).toHaveLength(1)
    expect(normalPosts).toHaveLength(0)
    streamAfterSend = false
    if (sendNow) {
        chat.stop.mockImplementation(() => { chat.status = 'ready'; finish() })
        expect(button('Send queued message now').disabled).toBe(false)
        await click('Send queued message now')
        expect(chat.stop).toHaveBeenCalledTimes(1)
    } else await act(async () => { chat.status = 'ready'; finish() })
    expect(normalPosts).toHaveLength(1)
    expect(normalPosts[0]).toMatchObject({ requestId: queued.id, text: queued.text })
    expect(questionPosts).toHaveLength(1)
})

test.each(['poll', 'stop'] as const)('a reopened run finishing through %s cannot flush against stale no-question history', async finishVia => {
    vi.useFakeTimers()
    questions.set('one', null); running = true
    const queued = queueItem(); queues.set('one', queued)
    await render('one', { text: 'Keep separate draft' })
    let resolve!: (response: Response) => void
    readQuestion = () => new Promise<Response>(done => { resolve = done })
    if (finishVia === 'poll') {
        running = false
        await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    } else await click('Send queued message now')
    expect(normalPosts).toHaveLength(0)
    expect(queues.get('one')?.id).toBe(queued.id)
    readQuestion = async () => Response.json({ question })
    await act(async () => { resolve(Response.json({ question })) })
    expect(container.querySelector('[data-hitl="option-0"]')).not.toBeNull()
    expect(button('Send queued message now').disabled).toBe(true)
    expect(normalPosts).toHaveLength(0)
})
