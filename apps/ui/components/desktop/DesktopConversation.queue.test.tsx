// @vitest-environment happy-dom
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages, type DesktopLanguage } from '@/lib/desktop/locale'
import type { DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { DesktopConversation, type ComposerDraft } from './DesktopConversation'
import { DesktopLocale } from './DesktopLocale'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = vi.hoisted(() => ({ messages: [] as UIMessage[], status: 'ready', error: undefined as Error | undefined, sendMessage: vi.fn(), stop: vi.fn(), setMessages: vi.fn(), clearError: vi.fn() }))
let transportFetch: typeof fetch
vi.mock('@ai-sdk/react', () => ({ useChat: ({ transport }: { transport: { fetch: typeof fetch } }) => { transportFetch = transport.fetch; return chat } }))
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (ready: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))

let root: Root, container: HTMLDivElement, running: boolean, stopResponse: () => Promise<Response>, reconcileMissing: boolean, loseEnqueueAck: boolean, queueReads: number
let beforeReview: (() => Promise<void>) | undefined
const saved = new Map<string, DesktopQueuedMessage>()
const sent: Record<string, unknown>[] = []
const firstRun = 'first-run'
const agent = { id: 'agent', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
const item = (state: DesktopQueuedMessage['state'] = 'waiting'): DesktopQueuedMessage => ({ id: crypto.randomUUID(), text: 'Saved follow-up', attachmentPath: 'notes.md', createdAt: Date.now(), behindRunId: firstRun, state })

beforeEach(() => {
    running = true; reconcileMissing = false; loseEnqueueAck = false; queueReads = 0; beforeReview = undefined; saved.clear(); sent.length = 0
    chat.status = 'ready'; chat.error = undefined; chat.stop.mockReset(); chat.sendMessage.mockReset()
    chat.clearError.mockImplementation(() => { chat.error = undefined })
    stopResponse = async () => { running = false; return Response.json({ canceled: 1, alreadyFinished: false }) }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) {
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body)), key = body.scope.sessionId ?? body.scope.tabUid
                if (body.action === 'review') await beforeReview?.()
                const current = saved.get(key)
                if (body.action === 'enqueue') {
                    saved.set(key, body.item)
                    if (loseEnqueueAck) { loseEnqueueAck = false; throw new Error('Enqueue acknowledgement lost') }
                }
                else if (current?.id === body.id && body.action === 'remove') saved.delete(key)
                else if (current && current.id === body.id) saved.set(key, { ...current, state: body.action === 'attempt' ? 'sending' : 'review' })
                return Response.json({ queued: saved.get(key) ?? null })
            }
            queueReads++
            return Response.json({ queued: saved.get(url.searchParams.get('sessionId') ?? url.searchParams.get('tabUid')!) ?? null })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.pathname.endsWith('/stop')) return init?.method === 'POST' ? stopResponse() : Response.json({ running, runId: running ? firstRun : null, failedRunId: null })
        if (url.pathname.endsWith('/chat')) {
            const body = JSON.parse(String(init?.body)); sent.push(body)
            if (body.reconcileOnly && reconcileMissing) return Response.json({ error: 'Not sent' }, { status: 404 })
            return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId, 'x-run-id': body.requestId } })
        }
        const background = desktopBackgroundRead(input, init); if (background) return background
        throw new Error('Unexpected request: ' + url.pathname)
    }))
    chat.sendMessage.mockImplementation(async (_message: unknown, options: { body: object }) => {
        const response = await transportFetch('/api/desktop/chat', { method: 'POST', body: JSON.stringify(options.body) })
        await response.text()
    })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = (sessionId = 'one', initialDraft?: ComposerDraft, language?: DesktopLanguage) => act(async () => {
    const conversation = <DesktopConversation agent={agent} sessionId={sessionId} sessions={[]} initialDraft={initialDraft} onChatSession={() => {}} onSelectSession={() => {}} />
    root.render(language ? <DesktopLocale initial={language}>{conversation}</DesktopLocale> : conversation)
})
const button = (label: string) => [...container.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)!
const click = (label: string) => act(async () => { button(label).click() })
const type = (text: string) => act(async () => {
    const el = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
})
async function finishRun() { chat.status = 'streaming'; await render(); running = false; chat.status = 'ready'; await render() }

test('queued chat uses the workspace language for its badge and action labels', async () => {
    const source = await loadMessages('fr')
    const language: DesktopLanguage = { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', source) }
    await render('one', undefined, language)
    await type('Suivi après cette réponse')
    await click(source.chat.composer.editor.send)
    const send = button(source.chat.queued.sendNowLabel)
    expect(send).toBeTruthy()
    expect(send.closest('.grid')?.textContent).toContain(source.chat.queued.badge)
    await click(source.chat.queued.removeLabel)
    expect(saved.has('one')).toBe(false)
    expect(sent).toHaveLength(0)
})

test('busy Send saves the attachment and exact chat, then flushes once using its stored UUID', async () => {
    await render('one', { text: '', attachment: 'notes.md' })
    await type('Read the note after this reply'); await click('Send')
    const queued = saved.get('one')!
    expect(queued).toMatchObject({ text: 'Read the note after this reply', attachmentPath: 'notes.md', behindRunId: firstRun })
    expect(container.textContent).toContain('Queued')
    expect(chat.sendMessage).not.toHaveBeenCalled()
    await finishRun()
    expect(chat.sendMessage).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ agentId: 'agent', sessionId: 'one', text: queued.text, requestId: queued.id, attachmentPath: 'notes.md' }])
    expect(saved.has('one')).toBe(false)
})

test('Send in the full editor queues the same long draft behind the current reply', async () => {
    const text = 'Prepare the follow-up after this reply. '.repeat(10).trim()
    await render('one', { text: '', attachment: 'notes.md' })
    await type(text)
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Open the full editor"]')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Write your message')
    const send = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Send')!
    await act(async () => { send.click() })
    const queued = saved.get('one')
    expect(queued).toMatchObject({ text, attachmentPath: 'notes.md', behindRunId: firstRun })
    expect(sent).toHaveLength(0)
    await finishRun()
    expect(sent).toEqual([{ agentId: 'agent', sessionId: 'one', text, requestId: queued!.id, attachmentPath: 'notes.md' }])
    expect(saved.has('one')).toBe(false)
})

test('Send now waits for successful cancellation, and a failed stop leaves the queued message intact', async () => {
    await render(); await type('Next please'); await click('Send')
    const queued = saved.get('one')!
    stopResponse = async () => Response.json({ error: 'Stop failed' }, { status: 502 })
    await click('Send queued message now')
    expect(sent).toHaveLength(0); expect(saved.get('one')?.id).toBe(queued.id)
    let release!: (response: Response) => void
    stopResponse = () => new Promise(resolve => { release = resolve })
    await click('Send queued message now')
    expect(sent).toHaveLength(0)
    await act(async () => { running = false; release(Response.json({ canceled: 1 })) })
    expect(sent).toHaveLength(1); expect(sent[0].requestId).toBe(queued.id)
})

test('reopening an old waiting item restores its draft without sending or replacing a newer draft', async () => {
    const queued = item(); saved.set('one', queued); running = false
    await render('one', { text: 'Newer unsent draft' })
    expect(container.querySelector('textarea')!.value).toBe('Newer unsent draft')
    expect(saved.get('one')).toMatchObject({ id: queued.id, state: 'review' })
    expect(sent).toHaveLength(0)
    await click('Remove queued message')
    expect(saved.has('one')).toBe(false)
    expect(container.querySelector('textarea')!.value).toBe('Newer unsent draft')
})

test.each([false, true])('a queue changed during recovery cannot restore the stale draft (replacement: %s)', async replaced => {
    const original = item()
    saved.set('one', original)
    running = false
    const reviewStarted = Promise.withResolvers<void>()
    const resumeReview = Promise.withResolvers<void>()
    beforeReview = async () => {
        reviewStarted.resolve()
        await resumeReview.promise
    }
    await render()
    await reviewStarted.promise
    const replacement = { ...item(), text: 'Newer queued follow-up' }
    if (replaced) saved.set('one', replacement)
    else saved.delete('one')
    await act(async () => { resumeReview.resolve() })
    expect(container.querySelector('textarea')!.value).toBe(replaced ? replacement.text : '')
    const visibleQueue = container.querySelector('[aria-label="Send queued message now"]')?.closest('.grid:not([inert])')
    expect(visibleQueue?.textContent ?? '').not.toContain(original.text)
    expect(sent).toHaveLength(0)
})

test('an interrupted send reconciles the same ID after remount without sending a second message', async () => {
    const queued = item('sending'); saved.set('one', queued); running = false
    await render()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ requestId: queued.id, reconcileOnly: true, attachmentPath: 'notes.md' })
    expect(chat.sendMessage).not.toHaveBeenCalled()
    expect(saved.has('one')).toBe(false)
})

test('an unaccepted interrupted send restores a review draft and retries with its original UUID', async () => {
    const queued = item('sending'); saved.set('one', queued); running = false; reconcileMissing = true
    await render()
    expect(container.querySelector('textarea')!.value).toBe(queued.text)
    expect(chat.sendMessage).not.toHaveBeenCalled()
    await click('Send')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ requestId: queued.id, text: queued.text, attachmentPath: 'notes.md' })
    expect(sent[1]).not.toHaveProperty('reconcileOnly')
})

test('a restored queue draft and its full editor follow the workspace language', async () => {
    const queued = item('sending')
    const source = await loadMessages('fr')
    const language: DesktopLanguage = { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', source) }
    saved.set('one', queued)
    running = false
    reconcileMissing = true
    await render('one', undefined, language)
    expect(container.querySelector('textarea')!.value).toBe(queued.text)
    expect(container.textContent).toContain('Vérifiez le message en attente enregistré avant de l’envoyer.')
    await type(queued.text.repeat(30))
    await click(source.chat.composer.openEditor)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(source.chat.composer.editor.title)
    expect(dialog.textContent).toContain(source.chat.composer.editor.hint)
    expect(dialog.textContent).toContain(source.chat.composer.editor.cancel)
    expect(chat.sendMessage).not.toHaveBeenCalled()
})

test('switching conversations never sends or removes the other chat’s queue', async () => {
    const one = item(), two = { ...item(), text: 'Second chat' }
    saved.set('one', one); saved.set('two', two)
    await render('one'); await render('two')
    await click('Remove queued message')
    expect(saved.get('one')?.id).toBe(one.id)
    expect(saved.has('two')).toBe(false)
    expect(sent).toHaveLength(0)
})

test.each([true, false])('a lost enqueue acknowledgement keeps the matching composer as a review draft (preceding run active: %s)', async stillRunning => {
    await render()
    await type('Do not send this twice')
    loseEnqueueAck = true
    await click('Send')
    const queued = saved.get('one')!
    expect(container.querySelector('textarea')!.value).toBe(queued.text)
    expect(sent).toHaveLength(0)
    if (!stillRunning) await finishRun()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(saved.get('one')).toMatchObject({ id: queued.id, state: 'review' })
    expect(container.querySelector('textarea')!.value).toBe(queued.text)
    if (stillRunning) await finishRun()
    expect(sent).toHaveLength(0)
    await click('Send')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ requestId: queued.id, text: queued.text })
    expect(saved.has('one')).toBe(false)
    expect(container.querySelector('textarea')!.value).toBe('')
})

test('an uncertain enqueue blocks ordinary Send before any recovery read, then sends the recovered original UUID', async () => {
    await render()
    await type('Keep the original send identity')
    loseEnqueueAck = true
    await click('Send')
    const queued = saved.get('one')!
    const readsBeforeRecovery = queueReads
    await finishRun()
    expect(queueReads).toBe(readsBeforeRecovery)
    expect(button('Send').disabled).toBe(true)
    await click('Send')
    // The handler must also guard keyboard/programmatic submits, independently of the button.
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(sent).toHaveLength(0)
    expect(chat.sendMessage).not.toHaveBeenCalled()
    expect(saved.get('one')?.id).toBe(queued.id)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(queueReads).toBeGreaterThan(readsBeforeRecovery)
    expect(saved.get('one')).toMatchObject({ id: queued.id, state: 'review' })
    expect(button('Send').disabled).toBe(false)
    await click('Send')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ requestId: queued.id, text: queued.text })
    expect(saved.has('one')).toBe(false)
})

test('a queued multi-file draft keeps its order and sends the same immutable set once', async () => {
    await render('one', { text: 'Compare the files', attachments: ['docs/a.md', 'docs/b.md'] })
    await click('Send')
    const queued = saved.get('one')!
    expect(queued).toMatchObject({ text: 'Compare the files', attachmentPaths: ['docs/a.md', 'docs/b.md'], behindRunId: firstRun })
    expect(queued).not.toHaveProperty('attachmentPath')
    await finishRun()
    expect(sent).toEqual([{ agentId: 'agent', sessionId: 'one', text: 'Compare the files', requestId: queued.id, attachmentPaths: ['docs/a.md', 'docs/b.md'] }])
})
