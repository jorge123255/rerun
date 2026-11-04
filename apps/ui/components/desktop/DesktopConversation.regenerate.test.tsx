// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = { id: 'agent', name: 'Writer', description: '', createdAt: '', updatedAt: '' }
const sessions = ['original', 'alternate'].map(id => ({ id, title: id, agentId: agent.id, createdAt: '', updatedAt: '' }))
const row = (id: string, role: 'user' | 'assistant', text: string) => ({ id, role, parts: [{ type: 'text', text }] })
const firstQuestion = { ...row('engine-q1', 'user', 'Original file question'), metadata: { attachmentPath: 'version.md' } }
const original = [firstQuestion, row('engine-a1', 'assistant', 'Same answer'), row('engine-q2', 'user', 'Later question'), row('engine-a2', 'assistant', 'Same answer')]
const alternate = [firstQuestion, row('engine-alternate', 'assistant', 'Alternate answer')]

function Harness() {
    const [selected, select] = useState<string | null>('original')
    return <DesktopConversation agent={agent} sessions={sessions} sessionId={selected} onSelectSession={select} onChatSession={select} />
}

test('regenerates the selected saved reply in a separate chat and retries a lost response without duplicating it', async () => {
    const requests: Record<string, unknown>[] = []
    let completeRequest!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/chat')) {
            requests.push(JSON.parse(String(init?.body)))
            return new Promise<Response>(resolve => { completeRequest = resolve })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: url.pathname.includes('/alternate/') ? alternate : original })
        if (url.pathname.endsWith('/files')) return Response.json({ entries: [{ type: 'file', name: 'pending.md', size: 12 }] })
        return Response.json({ running: false })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const buttons = (label: string) => [...document.querySelectorAll('button')].filter(el => el.textContent?.trim() === label || el.getAttribute('aria-label') === label)
    const click = (label: string, index = 0) => act(async () => { buttons(label)[index].click() })
    const switchTo = (id: string) => act(async () => {
        const select = container.querySelector('select')!
        select.value = id
        select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const writeDraft = (text: string) => act(async () => {
        const composer = container.querySelector('textarea')!
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, text)
        composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const accepted = () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'alternate' } })
    try {
        await act(async () => { root.render(<Harness />) })
        expect(buttons('Regenerate reply')).toHaveLength(2)
        expect(buttons('Regenerate reply')[0].title).toContain('keeps the original')
        await click('Attach from Files')
        await click('pending.md')
        await writeDraft('Draft for the original')
        const firstButton = buttons('Regenerate reply')[0]
        await act(async () => { firstButton.click(); firstButton.click() })
        expect(requests).toHaveLength(1)
        expect(requests[0]).toEqual({ agentId: 'agent', sessionId: 'original', regenerateMessageId: 'engine-a1', requestId: expect.stringMatching(/^[\da-f-]{36}$/i) })
        expect(container.textContent).toContain('Later question')
        expect(buttons('Stop')[0].disabled).toBe(true)
        await act(async () => { completeRequest(Response.json({ error: 'The response was lost' }, { status: 502 })) })
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('The response was lost')
        expect(container.textContent).toContain('Later question')
        expect(buttons('Regenerate reply')).toHaveLength(2)

        await click('Regenerate reply')
        expect(requests[1]).toEqual(requests[0])
        await act(async () => { completeRequest(accepted()) })
        expect(container.querySelector('select')!.value).toBe('alternate')
        expect(container.textContent).toContain('Alternate answer')
        expect(container.textContent).not.toContain('Later question')
        expect(container.querySelector('textarea')!.value).toBe('')
        expect(buttons('Remove attachment pending.md')).toHaveLength(0)
        expect(container.querySelector('[title="version.md"]')).not.toBeNull()
        await writeDraft('Draft for the alternate')
        await switchTo('original')
        expect(container.querySelector('textarea')!.value).toBe('Draft for the original')
        expect(buttons('Remove attachment pending.md')).toHaveLength(1)
        expect(container.textContent).toContain('Later question')
        await switchTo('alternate')
        expect(container.querySelector('textarea')!.value).toBe('Draft for the alternate')
        await switchTo('original')
        await click('Regenerate reply')
        expect(requests[2].requestId).not.toBe(requests[0].requestId)
        await act(async () => { completeRequest(accepted()) })
        expect(requests).toHaveLength(3)
    } finally {
        await act(async () => { root.unmount() })
        container.remove()
        vi.unstubAllGlobals()
    }
})

test('stopping a regenerating reply cancels only the alternate run', async () => {
    const stopped: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: url.pathname.includes('/alternate/') ? alternate : original })
        if (url.pathname.endsWith('/chat')) {
            expect(JSON.parse(String(init?.body)).regenerateMessageId).toBe('engine-a2')
            const body = new ReadableStream<Uint8Array>({ start(controller) {
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
                controller.enqueue(new TextEncoder().encode('data: {"type":"start","messageId":"streaming"}\n\n'))
            } })
            return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'alternate' } })
        }
        if (url.pathname.endsWith('/stop') && init?.method === 'POST') {
            stopped.push(url.pathname)
            return Response.json({ canceled: 1 })
        }
        return Response.json({ running: false })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const button = (label: string) => [...container.querySelectorAll('button')].filter(el => el.textContent?.trim() === label).at(-1)
    try {
        await act(async () => { root.render(<Harness />) })
        await act(async () => { button('Regenerate reply')!.click() })
        expect(container.querySelector('select')!.value).toBe('alternate')
        expect(button('Regenerate reply')).toBeUndefined()
        expect(button('Stop')?.disabled).toBe(false)
        await act(async () => { button('Stop')!.click() })
        expect(stopped).toEqual(['/api/desktop/sessions/alternate/stop'])
        expect(button('Stop')).toBeUndefined()
    } finally {
        await act(async () => { root.unmount() })
        container.remove()
        vi.unstubAllGlobals()
    }
})
