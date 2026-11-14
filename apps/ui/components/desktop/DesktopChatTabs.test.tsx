// @vitest-environment happy-dom
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { DesktopChatTabs } from './DesktopChatTabs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let drafts: ReturnType<typeof createDesktopDraftFixture>
beforeEach(() => { drafts = createDesktopDraftFixture() })

test('a first-mounted blank tab is registered before its draft is read', async () => {
    const agent = { id: 'first-mount-owner', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
    const registered = new Set<string>()
    const order: string[] = []
    let tabUid = ''
    let prematureReads = 0
    let acceptTabs!: () => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/tabs') && options?.method === 'PUT') {
            const body = JSON.parse(String(options.body)) as { tabs: { uid: string; id: string | null }[]; baseRevision: number }
            order.push('tabs:start')
            expect(body.tabs).toHaveLength(1)
            expect(body.tabs[0].id).toBeNull()
            tabUid = body.tabs[0].uid
            return new Promise<Response>(resolve => {
                acceptTabs = () => {
                    for (const tab of body.tabs) registered.add(tab.uid)
                    drafts.handle(input, options)
                    order.push('tabs:accepted')
                    resolve(Response.json({ tabs: { revision: body.baseRevision + 1 } }))
                }
            })
        }
        if (url.pathname.endsWith('/draft') && (options?.method ?? 'GET') === 'GET') {
            const uid = url.searchParams.get('tabUid')!
            order.push(`draft:${uid}`)
            if (!registered.has(uid)) {
                prematureReads++
                return Response.json({ error: 'This conversation tab is closed. Reopen it before saving a draft.' }, { status: 404 })
            }
        }
        const draftResponse = drafts.handle(input, options)
        if (draftResponse) return draftResponse
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        const background = desktopBackgroundRead(input, options); if (background) return background
        throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopChatTabs agent={agent} sessions={[]} initialLayout={null}
            requested={null} selected refreshSessions={async () => {}} reload={() => {}} onClosePanel={() => {}} onOpenModelSettings={() => {}} />) })
        expect(tabUid).not.toBe('')
        expect(order).toEqual(['tabs:start'])
        expect(prematureReads).toBe(0)
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)
        await act(async () => { acceptTabs() })
        expect(order).toEqual(['tabs:start', 'tabs:accepted', `draft:${tabUid}`])
        expect(prematureReads).toBe(0)
        expect(container.querySelector('[role="alert"]')).toBeNull()
        expect(container.textContent).not.toContain('Retry saving draft')
        const composer = container.querySelector<HTMLTextAreaElement>('textarea')!
        expect(composer.disabled).toBe(false)
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'A draft on the first opening')
            composer.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(composer.value).toBe('A draft on the first opening')
        const saved = await drafts.handle(`/api/desktop/agents/${agent.id}/draft?tabUid=${encodeURIComponent(tabUid)}`)!.json()
        expect(saved.draft.text).toBe('A draft on the first opening')
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals(); container.remove() }
})

test.each(['thread', 'general'] as const)('regeneration of a %s stays on its own transport and keeps the original draft', async kind => {
    const agent = { id: 'a', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
    const sessions = ['Source', 'Other', 'Alternate'].map((title, index) => ({
        id: title.toLowerCase(), agentId: agent.id, title, createdAt: '', updatedAt: '', kind: index === 0 ? kind : 'thread' as const,
    }))
    const tabs = sessions.slice(0, 2).map((session, index) => ({
        uid: index === 0 && kind === 'general' ? `general:${agent.id}` : session.id + '-tab', id: session.id, title: session.title,
    }))
    drafts.seedTabs(agent.id, tabs)
    let resolve!: (r: Response) => void
    const requests: Record<string, string>[] = []
    const writes: { activeIndex: number; tabs: { id: string }[] }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const draftResponse = drafts.handle(input, options)
        if (draftResponse) return draftResponse
        const url = String(input)
        if (url.endsWith('/approvals') && (options?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (options?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url) && (options?.method ?? 'GET') === 'GET') return Response.json({ queued: null })
        if (url.endsWith('/tabs')) {
            const body = JSON.parse(String(options?.body))
            writes.push(body)
            return Response.json({ tabs: { revision: body.baseRevision + 1 } })
        }
        if (url.endsWith('/chat')) {
            requests.push(JSON.parse(String(options?.body)))
            return new Promise<Response>(r => { resolve = r })
        }
        const id = url.match(/sessions\/([^/]+)\/messages$/)?.[1]
        if (id) return Response.json({ messages: [
            { id: 'q', role: 'user', parts: [{ type: 'text', text: 'A question' }] },
            { id: 'engine-' + id, role: 'assistant', parts: [{ type: 'text', text: id + ' answer' }] },
        ] })
        if (url.split('?')[0].endsWith('/files')) return Response.json({ entries: [{ type: 'file', name: 'original.txt', size: 4 }] })
        if (url.endsWith('/stop')) return Response.json({ running: false })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        const background = desktopBackgroundRead(input, options); if (background) return background
        throw Error('Unexpected request: ' + url)
    }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const visible = () => container.querySelector<HTMLElement>('[data-desktop-tab-active="true"]')!
    const click = (label: string) => act(async () => {
        const button = Array.from(document.querySelectorAll('button')).find(b => !b.closest('[hidden]') && (b.getAttribute('aria-label') === label || b.textContent?.trim() === label))
        expect(button, label + ': ' + document.querySelector('[role="dialog"]')?.textContent).toBeTruthy(); button!.click()
    })
    try {
        await act(async () => { root.render(<DesktopChatTabs agent={agent} sessions={sessions} initialLayout={{ tabs, activeIndex: 0, revision: 1 }}
            requested={null} selected refreshSessions={async () => {}} reload={() => {}} onClosePanel={() => {}} onOpenModelSettings={() => {}} />) })
        await click('Attach from Files'); await click('original.txt'); await click('Done')
        await act(async () => {
            const composer = visible().querySelector('textarea')!
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'A draft for the original')
            composer.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await click('Regenerate')
        await click('Other')
        expect(visible().textContent).toContain('other answer')
        await act(async () => { resolve(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'alternate' } })) })
        expect(visible().textContent).toContain('other answer')
        await click('Alternate')
        expect(visible().textContent).toContain('alternate answer')
        expect(visible().querySelector('textarea')?.value).toBe('')
        expect(visible().textContent).not.toContain('original.txt')
        await click(kind === 'general' ? 'General' : 'Source')
        expect(visible().textContent).toContain('source answer')
        expect(visible().textContent).toContain('original.txt')
        expect(visible().querySelector('textarea')?.value).toBe('A draft for the original')
        expect(writes.at(-1)?.tabs.map(t => t.id)).toEqual(kind === 'general'
            ? ['source', 'other', 'alternate'] : [null, 'source', 'alternate', 'other'])
        if (kind === 'general') expect(writes.at(-1)?.tabs[0]).toEqual({ uid: `general:${agent.id}`, id: 'source' })
        expect(requests).toEqual([{ agentId: 'a', sessionId: 'source', regenerateMessageId: 'engine-source', requestId: expect.any(String) }])
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals(); container.remove() }
})

test('keeps an unaccepted first send open, then allows its bound running tab to close without cancelling the run', async () => {
    const agent = { id: 'a', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
    const sessions = ['other', 'started'].map(id => ({ id, agentId: agent.id, title: id, createdAt: '', updatedAt: '' }))
    const tabs = [{ uid: 'blank', id: null, title: 'New conversation' }, { uid: 'other', id: 'other', title: 'other' }]
    drafts.seedTabs(agent.id, tabs)
    let accept!: (r: Response) => void
    let finish!: () => void
    let stopRequests = 0
    let sent: unknown
    const workspaceModel = { connectionId: 'fixture-openai', provider: 'openai', name: 'Fixture OpenAI', model: 'fixture-model', label: 'Fixture model' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const draftResponse = drafts.handle(input, options)
        if (draftResponse) return draftResponse
        const url = String(input)
        if (url.endsWith('/approvals') && (options?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (options?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url) && (options?.method ?? 'GET') === 'GET') return Response.json({ queued: null })
        if (url.endsWith('/tabs')) return Response.json({ tabs: { revision: JSON.parse(String(options?.body)).baseRevision + 1 } })
        if (url.endsWith('/chat')) { sent = JSON.parse(String(options?.body)); return new Promise<Response>(r => { accept = r }) }
        if (url.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.endsWith('/stop')) { if (options?.method === 'POST') stopRequests++; return Response.json({ running: false }) }
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: workspaceModel, coworker: null, conversation: null, effective: { source: 'workspace', ...workspaceModel, available: true } })
        const background = desktopBackgroundRead(input, options); if (background) return background
        throw Error('Unexpected request: ' + url)
    }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const visible = () => container.querySelector<HTMLElement>('[data-desktop-tab-active="true"]')!
    const click = (label: string) => act(async () => {
        const button = Array.from(document.querySelectorAll('button')).find(b => !b.closest('[hidden]') && (b.getAttribute('aria-label') === label || b.textContent?.trim() === label))
        expect(button, label).toBeTruthy(); button!.click()
    })
    try {
        await act(async () => { root.render(<DesktopChatTabs agent={agent} sessions={sessions} initialLayout={{ tabs, activeIndex: 0, revision: 1 }}
            requested={null} selected refreshSessions={async () => {}} reload={() => {}} onClosePanel={() => {}} onOpenModelSettings={() => {}} />) })
        await act(async () => {
            const composer = visible().querySelector('textarea')!
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'First turn')
            composer.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await click('Send')
        expect(sent).toMatchObject({ agentId: 'a', tabUid: 'blank', text: 'First turn' })
        await click('Close New conversation')
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('conversation is starting')
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        await click('other')
        await act(async () => { accept(new Response(new ReadableStream({ start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('data: {"type":"start","messageId":"one"}\n\n'))
            finish = () => { controller.enqueue(encoder.encode('data: {"type":"finish"}\n\ndata: [DONE]\n\n')); controller.close() }
        } }), { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'started' } })) })
        expect(visible().querySelector('[aria-pressed="true"]')?.textContent).toBe('other')
        await click('Close started')
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('keep running')
        await click('Cancel')
        expect(visible().querySelector('[aria-label="Close started"]')).toBeTruthy()
        await click('Close started'); await click('Close')
        expect(visible().querySelector('[aria-label="Close started"]')).toBeNull()
        await act(async () => { finish() })
        expect(stopRequests).toBe(0)
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals(); container.remove() }
})

test('a refused fork layout keeps the source tab and draft instead of restoring it into the alternate', async () => {
    const agent = { id: 'fork-owner', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
    const sessions = ['source', 'alternate'].map(id => ({ id, agentId: agent.id, title: id, createdAt: '', updatedAt: '' }))
    const tabs = [{ uid: 'source-tab', id: 'source', title: 'source' }]
    drafts.seedTabs(agent.id, tabs)
    let rejected = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/tabs') && options?.method === 'PUT') {
            const body = JSON.parse(String(options.body))
            if (body.tabs.some((tab: { id: string | null }) => tab.id === 'alternate')) {
                rejected++
                return Response.json({ error: 'The alternate tab could not be saved.' }, { status: 503 })
            }
            drafts.handle(input, options)
            return Response.json({ tabs: { revision: body.baseRevision + 1 } })
        }
        const draftResponse = drafts.handle(input, options)
        if (draftResponse) return draftResponse
        if (url.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.endsWith('/questions')) return Response.json({ question: null })
        if (url.includes('/queue?')) return Response.json({ queued: null })
        if (url.endsWith('/stop')) return Response.json({ running: false })
        if (url.includes('/feedback?')) return Response.json({ votes: [] })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.endsWith('/messages')) return Response.json({ messages: [
            { id: 'q', role: 'user', parts: [{ type: 'text', text: 'A question' }] },
            { id: 'engine-source', role: 'assistant', parts: [{ type: 'text', text: 'The original answer' }] },
        ] })
        if (url.endsWith('/chat')) return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'alternate' } })
        const background = desktopBackgroundRead(input, options); if (background) return background
        throw new Error(`Unexpected request: ${url}`)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopChatTabs agent={agent} sessions={sessions} initialLayout={{ tabs, activeIndex: 0, revision: 1 }}
            requested={null} selected refreshSessions={async () => {}} reload={() => {}} onClosePanel={() => {}} onOpenModelSettings={() => {}} />) })
        const input = container.querySelector('textarea')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this with the original')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        const regenerate = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Regenerate')
        expect(regenerate).toBeDefined()
        await act(async () => { regenerate!.click() })
        expect(rejected).toBe(1)
        expect(container.textContent).toContain('The alternate tab could not be saved.')
        expect(container.querySelector('[aria-label="Close source"]')).not.toBeNull()
        expect(container.querySelector('[aria-label="Close alternate"]')).toBeNull()
        expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep this with the original')
        const stored = await drafts.handle(`/api/desktop/agents/${agent.id}/draft?tabUid=source-tab`)!.json()
        expect(stored.draft.text).toBe('Keep this with the original')
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals(); container.remove() }
})
