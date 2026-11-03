// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { DesktopChatTabs } from './DesktopChatTabs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('regeneration stays on its own transport while another tab is active, and keeps the source draft in its original conversation', async () => {
    const agent = { id: 'a', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
    const sessions = ['Source', 'Other', 'Alternate'].map(title => ({ id: title.toLowerCase(), agentId: agent.id, title, createdAt: '', updatedAt: '' }))
    const tabs = sessions.slice(0, 2).map(s => ({ uid: s.id + '-tab', id: s.id, title: s.title }))
    let resolve!: (r: Response) => void
    const requests: Record<string, string>[] = []
    const writes: { activeIndex: number; tabs: { id: string }[] }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input)
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
        await click('Attach from Files'); await click('original.txt')
        await act(async () => {
            const composer = visible().querySelector('textarea')!
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'A draft for the original')
            composer.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await click('Regenerate reply')
        await click('Other')
        expect(visible().textContent).toContain('other answer')
        await act(async () => { resolve(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'alternate' } })) })
        expect(visible().textContent).toContain('other answer')
        await click('Alternate')
        expect(visible().textContent).toContain('alternate answer')
        expect(visible().querySelector('textarea')?.value).toBe('')
        expect(visible().textContent).not.toContain('original.txt')
        await click('Source')
        expect(visible().textContent).toContain('source answer')
        expect(visible().textContent).toContain('original.txt')
        expect(visible().querySelector('textarea')?.value).toBe('A draft for the original')
        expect(writes.at(-1)?.tabs.map(t => t.id)).toEqual(['source', 'alternate', 'other'])
        expect(requests).toEqual([{ agentId: 'a', sessionId: 'source', regenerateMessageId: 'engine-source', requestId: expect.any(String) }])
    } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals(); container.remove() }
})

test('keeps an unaccepted first send open, then allows its bound running tab to close without cancelling the run', async () => {
    const agent = { id: 'a', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
    const sessions = ['other', 'started'].map(id => ({ id, agentId: agent.id, title: id, createdAt: '', updatedAt: '' }))
    const tabs = [{ uid: 'blank', id: null, title: 'New conversation' }, { uid: 'other', id: 'other', title: 'other' }]
    let accept!: (r: Response) => void
    let finish!: () => void
    let stopRequests = 0
    let sent: unknown
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/tabs')) return Response.json({ tabs: { revision: JSON.parse(String(options?.body)).baseRevision + 1 } })
        if (url.endsWith('/chat')) { sent = JSON.parse(String(options?.body)); return new Promise<Response>(r => { accept = r }) }
        if (url.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.endsWith('/stop')) { if (options?.method === 'POST') stopRequests++; return Response.json({ running: false }) }
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
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
