// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { DesktopQueuedMessage } from '@/lib/desktop/queued-message'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { desktopDraftRecord, forgetCoworkerDrafts, saveDesktopDraft } from '@/lib/desktop/draft-writes'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = vi.hoisted(() => ({ messages: [] as UIMessage[], status: 'ready', error: undefined, sendMessage: vi.fn(), stop: vi.fn(), setMessages: vi.fn(), clearError: vi.fn() }))
let transportFetch: typeof fetch
vi.mock('@ai-sdk/react', () => ({ useChat: ({ transport }: { transport: { fetch: typeof fetch } }) => { transportFetch = transport.fetch; return chat } }))
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (ready: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))

const agent = { id: 'mention-owner', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
const tabUid = 'mention-draft-tab', sessionId = 'mention-chat'
const targets = [
    { agentId: 'same-name-first', name: 'Alex', handle: null, boxName: 'First Box', enabled: true, callable: true },
    { agentId: 'same-name-selected', name: 'Alex', handle: null, boxName: 'Second Box', enabled: true, callable: true },
]
const selected = [{ targetId: 'same-name-selected', token: '@Alex', start: 0, end: 5 }]
let root: Root | undefined, container: HTMLDivElement, running: boolean, queued: DesktopQueuedMessage | null
let drafts: ReturnType<typeof createDesktopDraftFixture>
let roster = targets
const sent: Record<string, unknown>[] = []
const unexpected: string[] = []
beforeEach(() => {
    running = false; queued = null; roster = targets; sent.length = 0
    chat.status = 'ready'; chat.messages = []; chat.sendMessage.mockReset(); chat.stop.mockReset()
    chat.setMessages.mockImplementation((messages: UIMessage[]) => { chat.messages = messages })
    drafts = createDesktopDraftFixture(); drafts.seedTabs(agent.id, [{ uid: tabUid, id: sessionId }])
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local'), method = init?.method ?? 'GET'
        const draft = drafts.handle(input, init); if (draft) return draft
        if (url.pathname.endsWith('/mentions') && method === 'GET') return Response.json({ targets: roster })
        if (url.pathname.endsWith('/queue')) {
            if (method === 'PUT') {
                const body = JSON.parse(String(init?.body))
                if (body.action === 'enqueue') queued = body.item
                else if (queued && queued.id === body.id) queued = body.action === 'remove' ? null : { ...queued, state: body.action === 'attempt' ? 'sending' : 'review' }
            }
            return Response.json({ queued })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.pathname.endsWith('/stop') && method === 'GET') return Response.json({ running, runId: running ? 'prior-run' : null, failedRunId: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/feedback')) return Response.json({ votes: [] })
        if (url.pathname.endsWith('/chat') && method === 'POST') {
            const body = JSON.parse(String(init?.body)); sent.push(body)
            return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': sessionId, 'x-run-id': body.requestId ?? 'sent-run' } })
        }
        const background = desktopBackgroundRead(input, init); if (background) return background
        unexpected.push(`${method} ${url.pathname}`)
        throw new Error('Unexpected request')
    }))
    chat.sendMessage.mockImplementation(async (message: { text: string }, options: { body: object }) => {
        const response = await transportFetch('/api/desktop/chat', { method: 'POST', body: JSON.stringify({ text: message.text, ...options.body }) })
        await response.text()
    })
    container = document.body.appendChild(document.createElement('div'))
})
afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); await saveDesktopDraft(desktopDraftRecord(agent.id, tabUid)) })
    root = undefined; container.remove(); forgetCoworkerDrafts(agent.id); vi.unstubAllGlobals()
    expect(unexpected.splice(0)).toEqual([])
})
async function render() {
    root ??= createRoot(container)
    await act(async () => root!.render(<DesktopConversation agent={agent} sessionId={sessionId} tabUid={tabUid} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />))
}
const composer = () => container.querySelector('textarea')!
async function type(text: string) {
    await act(async () => {
        const input = composer()
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
        input.setSelectionRange(text.length, text.length)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
}
async function pickSecond() {
    await type('  @')
    await act(async () => {
        const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.textContent?.includes('Second Box'))
        expect(option).toBeTruthy()
        option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    expect(composer().value).toBe('  @Alex ')
}
const submit = () => act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
const savedDraft = async () => (await drafts.handle(`/api/desktop/agents/${agent.id}/draft?tabUid=${tabUid}`)!.json()).draft
async function restart() {
    await act(async () => { await saveDesktopDraft(desktopDraftRecord(agent.id, tabUid)); root!.unmount() })
    root = undefined; forgetCoworkerDrafts(agent.id)
    await render()
}

test('selected same-name identity survives draft reload and rename; Send trims ranges without replacing the ID', async () => {
    await render(); await pickSecond()
    await act(async () => { await saveDesktopDraft(desktopDraftRecord(agent.id, tabUid)) })
    expect(await savedDraft()).toMatchObject({ text: '  @Alex ', coworkerMentions: [{ ...selected[0], start: 2, end: 7 }] })
    roster = targets.map(target => target.agentId === selected[0].targetId ? { ...target, name: 'Renamed researcher' } : target)
    await restart()
    expect(composer().value).toBe('  @Alex ')
    await submit()
    expect(sent).toEqual([{ text: '@Alex', agentId: agent.id, sessionId, coworkerMentions: selected }])
    expect(chat.sendMessage.mock.calls[0][0]).toMatchObject({ text: '@Alex', metadata: { coworkerMentions: selected } })
    expect(composer().value).toBe('')
})

test('busy send retains selected IDs in the queued item and resumes the same item after reload', async () => {
    running = true
    await render(); await pickSecond(); await submit()
    const original = queued!
    expect(original).toMatchObject({ text: '@Alex', coworkerMentions: selected, behindRunId: 'prior-run' })
    expect(sent).toEqual([])
    running = false
    await restart()
    expect(queued).toMatchObject({ id: original.id, state: 'review', coworkerMentions: selected })
    expect(composer().value).toBe('@Alex')
    await submit()
    expect(sent).toEqual([{ text: '@Alex', agentId: agent.id, sessionId, requestId: original.id, coworkerMentions: selected }])
    expect(queued).toBeNull()
})

test('typing a matching coworker name without picking it remains ordinary text', async () => {
    await render(); await type('@Alex'); await submit()
    expect(sent).toEqual([{ text: '@Alex', agentId: agent.id, sessionId }])
    expect(chat.sendMessage.mock.calls[0][0]).not.toHaveProperty('metadata.coworkerMentions')
})
