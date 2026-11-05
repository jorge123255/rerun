// @vitest-environment happy-dom
import { act, useEffect, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { DesktopComposerDraft, DesktopComposerDraftWrite } from '@/lib/desktop/composer-draft'
import type { DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = vi.hoisted(() => ({ messages: [] as UIMessage[], status: 'ready', error: undefined as Error | undefined,
    sendMessage: vi.fn(), stop: vi.fn(), setMessages: vi.fn(), clearError: vi.fn(), regenerate: vi.fn() }))
let transportFetch: typeof fetch
vi.mock('@ai-sdk/react', () => ({ useChat: ({ transport }: { transport: { fetch: typeof fetch } }) => { transportFetch = transport.fetch; return chat } }))
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (ready: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))
vi.mock('./DesktopAttachmentPicker', async original => ({
    ...await original<typeof import('./DesktopAttachmentPicker')>(),
    DesktopAttachmentPicker: ({ disabled, onChange }: { disabled: boolean; paths: readonly string[]; onChange: (paths: string[]) => void }) =>
        <button type="button" disabled={disabled} onClick={() => onChange(['second.md'])}>Choose second.md</button>,
}))
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => { if (!elements.has(tag)) elements.set(tag, plain(tag)); return elements.get(tag)! }
    return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
        motion: new Proxy(actual.motion, { get(target, key, receiver) {
            if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
            return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
        } }),
    }
})

let agent: { id: string; name: string; description: string; createdAt: string; updatedAt: string }
let root: Root, container: HTMLDivElement, stored: DesktopComposerDraft, queued: DesktopQueuedMessage | null
let readDraft: () => Promise<Response>, send: (body: Record<string, unknown>) => Promise<Response>
const writes: DesktopComposerDraftWrite[] = []
const posts: Record<string, unknown>[] = []
const history = new Map<string, UIMessage[]>()
const tabUid = 'draft-tab'
const suggestion: UIMessage = { id: 'engine-suggestion', role: 'assistant', parts: [
    { type: 'text', text: 'The report is ready.' },
    { type: 'dynamic-tool', toolName: 'suggest_replies', toolCallId: 'suggestion-tool', state: 'input-available', input: { replies: ['Find more'] } },
] }
function accepted(body: Record<string, unknown>) {
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream',
        'x-session-id': String(body.sessionId ?? 'created'), 'x-run-id': String(body.requestId ?? 'run-first') } })
}
function Harness({ initial }: { initial: string | null }) {
    const [sessionId, setSessionId] = useState(initial)
    return <DesktopConversation agent={agent} tabUid={tabUid} sessionId={sessionId} sessions={[]}
        onChatSession={setSessionId} onSelectSession={() => {}} />
}
const render = (initial: string | null = 'one') => act(async () => { root.render(<Harness initial={initial} />) })
const composer = () => container.querySelector<HTMLTextAreaElement>('#desktop-message')!
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)!
const click = (label: string) => act(async () => { expect(button(label)).toBeDefined(); button(label).click() })
const type = (text: string) => act(async () => {
    const el = composer()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
})
async function remount(initial = 'one') {
    await act(async () => { root.unmount() })
    forgetCoworkerDrafts(agent.id)
    root = createRoot(container)
    await render(initial)
}

beforeEach(() => {
    agent = { id: `draft-chat-${crypto.randomUUID()}`, name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
    stored = { revision: 0, text: '' }; queued = null; writes.length = 0; posts.length = 0; history.clear(); cancelDraftShutdown()
    chat.messages = []; chat.status = 'ready'; chat.error = undefined
    chat.sendMessage.mockReset(); chat.stop.mockReset(); chat.setMessages.mockReset(); chat.regenerate.mockReset()
    chat.clearError.mockImplementation(() => { chat.error = undefined })
    readDraft = async () => Response.json({ draft: stored })
    send = async body => accepted(body)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local'), sessionId = url.pathname.split('/')[4]
        if (url.pathname.endsWith('/upload-attempts')) {
            expect(url.pathname).toBe(`/api/desktop/agents/${agent.id}/upload-attempts`)
            expect(init?.method ?? 'GET').toBe('GET')
            expect(url.searchParams.get('tabUid')).toBe(tabUid)
            return Response.json({ attempts: [] })
        }
        if (url.pathname.endsWith('/draft')) {
            expect(url.pathname).toBe(`/api/desktop/agents/${agent.id}/draft`)
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body)) as DesktopComposerDraftWrite
                expect(body.tabUid).toBe(tabUid); writes.push(body)
                if (body.baseRevision !== stored.revision) return Response.json({ draft: stored }, { status: 409 })
                stored = { revision: stored.revision + 1, text: body.text, ...(body.attachmentPath && { attachmentPath: body.attachmentPath }) }
                return Response.json({ draft: stored })
            }
            expect(url.searchParams.get('tabUid')).toBe(tabUid)
            return readDraft()
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: history.get(sessionId) ?? [] })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/feedback')) return Response.json({ votes: [] })
        if (url.pathname.endsWith('/stop')) return Response.json({ running: false, runId: null, failedRunId: null })
        if (url.pathname.endsWith('/queue')) {
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body))
                if (body.action === 'enqueue') queued = body.item
                else if (queued?.id === body.id && body.action === 'remove') queued = null
                else if (queued && queued.id === body.id) queued = { ...queued, state: body.action === 'attempt' ? 'sending' : 'review' }
            }
            return Response.json({ queued })
        }
        if (url.pathname === '/api/desktop/chat' && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)); posts.push(body); return send(body)
        }
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`)
    }))
    chat.sendMessage.mockImplementation(async (message: { text: string }, options: { body: object }) => {
        try {
            const response = await transportFetch('/api/desktop/chat', { method: 'POST', body: JSON.stringify({ ...options.body, text: message.text }) })
            await response.text()
        } catch (cause) { chat.error = cause instanceof Error ? cause : new Error('Send failed'); chat.status = 'error' }
    })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
    await act(async () => { root.unmount() })
    forgetCoworkerDrafts(agent.id); cancelDraftShutdown(); container.remove(); vi.unstubAllGlobals()
})

test('a saved text and file draft hydrates before sending and survives a fresh mount after edits', async () => {
    let finish!: (response: Response) => void
    stored = { revision: 2, text: 'Saved ordinary draft', attachmentPath: 'notes.md' }
    readDraft = () => new Promise(resolve => { finish = resolve })
    await render()
    expect(composer().disabled).toBe(true)
    expect(button('Send').disabled).toBe(true)
    expect(button('Choose second.md').disabled).toBe(true)
    await act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(posts).toHaveLength(0)
    await act(async () => { finish(Response.json({ draft: stored })) })
    expect(composer().value).toBe('Saved ordinary draft')
    expect(button('Remove attachment notes.md')).toBeDefined()
    await type('Saved ordinary draft, edited')
    expect(stored).toMatchObject({ text: 'Saved ordinary draft, edited', attachmentPath: 'notes.md' })
    readDraft = async () => Response.json({ draft: stored })
    await remount()
    expect(composer().value).toBe('Saved ordinary draft, edited')
    expect(button('Remove attachment notes.md')).toBeDefined()
})

test('clicking a suggested reply preserves the persisted ordinary text and file draft', async () => {
    stored = { revision: 4, text: 'My separate draft', attachmentPath: 'notes.md' }
    history.set('one', [suggestion])
    await render(); await click('Find more')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toEqual({ agentId: agent.id, sessionId: 'one', requestId: expect.any(String), text: 'Find more' })
    expect(stored).toEqual({ revision: 4, text: 'My separate draft', attachmentPath: 'notes.md' })
    expect(writes).toHaveLength(0)
    expect(composer().value).toBe('My separate draft')
    await remount()
    expect(composer().value).toBe('My separate draft')
    expect(button('Remove attachment notes.md')).toBeDefined()
})

test('manual queue send waits for hydration and leaves the newer saved ordinary draft intact', async () => {
    let finish!: (response: Response) => void
    stored = { revision: 3, text: 'Newer ordinary draft', attachmentPath: 'notes.md' }
    queued = { id: crypto.randomUUID(), text: 'Older queued follow-up', attachmentPath: 'queued.md', createdAt: Date.now(), behindRunId: 'old-run', state: 'waiting' }
    const queuedId = queued.id
    readDraft = () => new Promise(resolve => { finish = resolve })
    await render(); await click('Send queued message now')
    expect(posts).toHaveLength(0)
    expect(queued?.id).toBe(queuedId)
    await act(async () => { finish(Response.json({ draft: stored })) })
    expect(composer().value).toBe('Newer ordinary draft')
    expect(posts).toHaveLength(0)
    await click('Send queued message now')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ requestId: queuedId, text: 'Older queued follow-up', attachmentPath: 'queued.md' })
    expect(stored).toEqual({ revision: 3, text: 'Newer ordinary draft', attachmentPath: 'notes.md' })
})

test('first-turn acceptance keeps newer typing and file selection on the same persisted tab', async () => {
    let finish!: (response: Response) => void
    send = () => new Promise(resolve => { finish = resolve })
    await render(null); await type('First question'); await click('Send')
    expect(posts).toHaveLength(1)
    await type('My newer draft'); await click('Choose second.md')
    expect(stored).toMatchObject({ text: 'My newer draft', attachmentPath: 'second.md' })
    await act(async () => { finish(accepted(posts[0])) })
    expect(composer().value).toBe('My newer draft')
    expect(button('Remove attachment second.md')).toBeDefined()
    await type('My newer draft continued')
    expect(stored).toMatchObject({ text: 'My newer draft continued', attachmentPath: 'second.md' })
    await remount('created')
    expect(composer().value).toBe('My newer draft continued')
    expect(button('Remove attachment second.md')).toBeDefined()
})

test('quit waits for an accepted send to clear its saved draft and keeps editing frozen until Stay', async () => {
    let finish!: (response: Response) => void
    send = () => new Promise(resolve => { finish = resolve })
    await render(); await type('Send this before quitting'); await click('Send')
    expect(posts).toHaveLength(1)
    let quitting!: Promise<boolean>
    await act(async () => { quitting = flushDesktopDrafts() })
    expect(composer().disabled).toBe(true)
    expect(button('Choose second.md').disabled).toBe(true)
    await act(async () => { finish(accepted(posts[0])); expect(await quitting).toBe(true) })
    expect(stored.text).toBe('')
    expect(composer().disabled).toBe(true)
    await act(async () => { cancelDraftShutdown() })
    expect(composer().disabled).toBe(false)
    await remount()
    expect(composer().value).toBe('')
})
