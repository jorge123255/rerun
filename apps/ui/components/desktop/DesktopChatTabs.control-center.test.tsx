// @vitest-environment happy-dom

import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { flushTabWrites } from '@/lib/desktop/tab-writes'
import type { DesktopChatRequest } from '@/lib/desktop/chat-request'
import type { DesktopTabLayout, DesktopTabWrite } from '@/lib/desktop/session-tabs'
import { DesktopChatTabs } from './DesktopChatTabs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = { id: 'exact-tab-owner', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
const sessions = ['Source', 'Other', 'Alternate'].map(title => ({ id: title.toLowerCase(), agentId: agent.id, title, createdAt: '', updatedAt: '' }))
const source = { uid: 'source-uid', id: 'source', title: 'Source' }
const other = { uid: 'other-uid', id: 'other', title: 'Other' }
const blank = { uid: 'persisted-blank-uid', id: null, title: 'New conversation' }
const pinnedGeneral = { uid: `general:${agent.id}`, id: null }
let root: Root | undefined
const unexpected: string[] = []

afterEach(async () => {
    await act(async () => { root?.unmount(); await flushTabWrites() })
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    expect(unexpected.splice(0)).toEqual([])
})

function fixture(initialLayout: DesktopTabLayout) {
    const drafts = createDesktopDraftFixture()
    drafts.seedTabs(agent.id, initialLayout.tabs)
    let persisted = initialLayout
    const writes: DesktopTabWrite[] = []
    const messageReads: string[] = []
    const draftReads: string[] = []
    const chatRequests: unknown[] = []
    const stopRequests: string[] = []
    let chat: (() => Response) | undefined
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        if (url.pathname === `/api/desktop/agents/${agent.id}/tabs` && method === 'PUT') {
            const body = JSON.parse(String(init?.body)) as DesktopTabWrite
            writes.push(body)
            expect(body.baseRevision).toBe(persisted.revision)
            drafts.handle(input, init)
            persisted = { ...body, revision: body.baseRevision + 1, tabs: body.tabs.map(tab => ({ ...tab, title: sessions.find(session => session.id === tab.id)?.title ?? 'New conversation' })) }
            return Response.json({ tabs: persisted })
        }
        if (url.pathname.endsWith('/draft') && method === 'GET') draftReads.push(url.searchParams.get('tabUid')!)
        const draftResponse = drafts.handle(input, init)
        if (draftResponse) return draftResponse
        const sessionId = url.pathname.match(/^\/api\/desktop\/sessions\/([^/]+)\/messages$/)?.[1]
        if (sessionId && method === 'GET') {
            messageReads.push(sessionId)
            return Response.json({ messages: [{ id: `reply-${sessionId}`, role: 'assistant', parts: [{ type: 'text', text: `${sessionId} answer` }] }] })
        }
        if (url.pathname.endsWith('/questions') && method === 'GET') return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals') && method === 'GET') return Response.json({ approval: null })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/stop')) {
            if (method === 'POST') stopRequests.push(url.pathname)
            return Response.json({ running: false })
        }
        if (url.pathname.endsWith('/model') && method === 'GET') return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null,
            effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.pathname === '/api/desktop/chat' && method === 'POST' && chat) {
            chatRequests.push(JSON.parse(String(init?.body)))
            return chat()
        }
        const request = `${method} ${url.pathname}${url.search}`
        const background = desktopBackgroundRead(input, init); if (background) return background
        unexpected.push(request)
        throw new Error(`Unexpected request: ${request}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    const render = (requested: DesktopChatRequest | null) => act(async () => {
        root!.render(<DesktopChatTabs agent={agent} sessions={sessions} initialLayout={initialLayout} requested={requested}
            selected refreshSessions={async () => {}} reload={() => {}} onClosePanel={() => {}} onOpenModelSettings={() => {}} />)
    })
    const savedDraft = async (uid: string) => (await drafts.handle(`/api/desktop/agents/${agent.id}/draft?tabUid=${uid}`)!.json()).draft
    return {
        container, render, writes, messageReads, draftReads, chatRequests, stopRequests,
        persisted: () => persisted,
        savedDraft,
        seed: (uid: string, text: string) => drafts.handle(`/api/desktop/agents/${agent.id}/draft`, { method: 'PUT', body: JSON.stringify({ tabUid: uid, requestId: crypto.randomUUID(), baseRevision: 0, text }) }),
        respondToChat: (reply: () => Response) => { chat = reply },
        active: () => container.querySelector<HTMLElement>('[data-desktop-tab-active="true"]'),
    }
}

async function click(label: string) {
    await act(async () => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => !item.closest('[hidden]') && (item.getAttribute('aria-label') === label || item.textContent?.trim() === label))
        expect(button, label).toBeTruthy()
        button!.click()
    })
}

async function type(composer: HTMLTextAreaElement, text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, text)
        composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

test('a cold exact-blank selection restores its persisted draft before mounting the unrelated saved chat', async () => {
    const app = fixture({ revision: 4, tabs: [source, blank], activeIndex: 0 })
    app.seed(blank.uid, 'Saved before restart in this blank tab')
    await app.render({ tabUid: blank.uid, sessionId: null })
    expect(app.active()?.querySelector('textarea')?.value).toBe('Saved before restart in this blank tab')
    expect(app.messageReads).toEqual([])
    expect(app.draftReads).toEqual([blank.uid])
    expect(app.persisted().tabs.map(tab => ({ uid: tab.uid, id: tab.id }))).toEqual([pinnedGeneral, { uid: source.uid, id: source.id }, { uid: blank.uid, id: null }])
    expect(app.persisted().activeIndex).toBe(2)
    await click('Source')
    expect(app.active()?.textContent).toContain('source answer')
    expect(app.messageReads).toEqual(['source'])
    expect((await app.savedDraft(blank.uid)).text).toBe('Saved before restart in this blank tab')
})

test('selecting a saved open tab uses its existing UID and does not create a duplicate', async () => {
    const app = fixture({ revision: 2, tabs: [source, other], activeIndex: 0 })
    app.seed(other.uid, 'Draft belongs to the other UID')
    await app.render({ tabUid: other.uid, sessionId: other.id })
    expect(app.messageReads).toEqual(['other'])
    expect(app.active()?.querySelector('textarea')?.value).toBe('Draft belongs to the other UID')
    const originalComposer = app.active()?.querySelector('textarea')
    const writes = app.writes.length
    await app.render({ tabUid: other.uid, sessionId: other.id })
    expect(app.active()?.querySelector('textarea')).toBe(originalComposer)
    expect(app.writes).toHaveLength(writes)
    expect(app.persisted().tabs.map(tab => tab.uid)).toEqual([pinnedGeneral.uid, source.uid, other.uid])
    expect(app.persisted().tabs.filter(tab => tab.id === other.id)).toHaveLength(1)
})

test.each([
    { label: 'closed', request: { tabUid: 'closed-uid', sessionId: null }, recover: null },
    { label: 'rebound', request: { tabUid: source.uid, sessionId: 'alternate' }, recover: { tabUid: source.uid, sessionId: source.id } },
])('a $label initial UID is rejected without a replacement or draft loss, and a fresh request recovers', async ({ request, recover }) => {
    const app = fixture({ revision: 3, tabs: [source, blank], activeIndex: 0 })
    app.seed(source.uid, 'Original saved draft')
    app.seed(blank.uid, 'Separate blank draft')
    await app.render(request)
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain('changed or closed')
    expect(app.container.querySelector('textarea')).toBeNull()
    expect(app.messageReads).toEqual([])
    expect(app.draftReads).toEqual([])
    expect(app.writes).toEqual([])
    expect((await app.savedDraft(source.uid)).text).toBe('Original saved draft')
    expect((await app.savedDraft(blank.uid)).text).toBe('Separate blank draft')
    await app.render(recover)
    expect(app.container.querySelector('[role="alert"]')).toBeNull()
    expect(app.active()?.textContent).toContain('source answer')
    expect(app.active()?.querySelector('textarea')?.value).toBe('Original saved draft')
    expect(app.container.querySelector('[data-testid="desktop-general-tab"]')).not.toBeNull()
    // Re-selecting the already active saved UID needs no layout write.
    expect(app.persisted().tabs.map(tab => tab.uid)).toEqual(recover ? [source.uid, blank.uid] : [pinnedGeneral.uid, source.uid, blank.uid])
})

test('a stale selection preserves a live reply and both mounted drafts until a valid selection returns', async () => {
    const app = fixture({ revision: 1, tabs: [source, other], activeIndex: 0 })
    app.seed(other.uid, 'Other unsent draft')
    let finish: (() => void) | undefined
    let streamClosed = false
    app.respondToChat(() => new Response(new ReadableStream({ start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode('data: {"type":"start","messageId":"live-answer"}\n\ndata: {"type":"text-start","id":"live-text"}\n\ndata: {"type":"text-delta","id":"live-text","delta":"Still replying"}\n\n'))
        finish = () => {
            if (streamClosed) return
            streamClosed = true
            controller.enqueue(encoder.encode('data: {"type":"text-end","id":"live-text"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n'))
            controller.close()
        }
    }, cancel() { streamClosed = true } }), { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'source', 'x-run-id': 'live-run' } }))
    try {
        await app.render(null)
        const sourceComposer = app.active()!.querySelector('textarea')!
        await type(sourceComposer, 'Start a reply')
        await click('Send')
        // The transport schedules stream renders separately from the click's React update.
        for (let attempt = 0; attempt < 50 && !app.active()?.textContent?.includes('Still replying'); attempt++) {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
        }
        expect(app.active()?.textContent).toContain('Still replying')
        expect(app.active()?.querySelector('[data-chat-find-ignore] [role="status"]')?.textContent).toBe('Writing...')
        await type(sourceComposer, 'Newer source draft while it replies')
        await click('Other')
        const otherComposer = app.active()!.querySelector('textarea')!
        expect(otherComposer.value).toBe('Other unsent draft')
        const writeCount = app.writes.length
        await app.render({ tabUid: source.uid, sessionId: 'alternate' })
        expect(app.container.querySelector('[role="alert"]')?.textContent).toContain('changed or closed')
        expect(app.active()).toBeNull()
        expect(app.container.contains(sourceComposer)).toBe(true)
        expect(app.container.contains(otherComposer)).toBe(true)
        expect(sourceComposer.value).toBe('Newer source draft while it replies')
        expect(otherComposer.value).toBe('Other unsent draft')
        expect(app.writes).toHaveLength(writeCount)
        expect(app.stopRequests).toEqual([])
        expect(finish).toBeTypeOf('function')
        await act(async () => { finish!() })
        await app.render({ tabUid: source.uid, sessionId: source.id })
        expect(app.container.querySelector('[role="alert"]')).toBeNull()
        expect(app.active()?.querySelector('textarea')).toBe(sourceComposer)
        expect(sourceComposer.value).toBe('Newer source draft while it replies')
        expect(app.chatRequests).toHaveLength(1)
        expect(app.stopRequests).toEqual([])
        expect((await app.savedDraft(other.uid)).text).toBe('Other unsent draft')
    } finally {
        await act(async () => { finish?.() })
    }
})

test('closing an exact-selected tab consumes the request and leaves the remaining tab and its draft intact', async () => {
    const app = fixture({ revision: 1, tabs: [source, other], activeIndex: 1 })
    app.seed(other.uid, 'Do not discard the remaining draft')
    const request = { tabUid: source.uid, sessionId: source.id }
    await app.render(request)
    expect(app.active()?.textContent).toContain('source answer')
    await click('Close Source')
    await app.render(request)
    expect(app.container.querySelector('[role="alert"]')).toBeNull()
    expect(app.active()?.textContent).toContain('other answer')
    expect(app.active()?.querySelector('textarea')?.value).toBe('Do not discard the remaining draft')
    expect(app.persisted().tabs.map(tab => tab.uid)).toEqual([pinnedGeneral.uid, other.uid])
    expect(app.container.querySelector('[aria-label="Close Source"]')).toBeNull()
})
