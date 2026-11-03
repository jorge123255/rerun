// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { DesktopConversation } from './DesktopConversation'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const answer = 'Shared answer'
const ada = { id: '11111111-1111-4111-8111-111111111111', name: 'Ada', description: '', createdAt: '', updatedAt: '' }
const bea = { id: '22222222-2222-4222-8222-222222222222', name: 'Bea', description: '', createdAt: '', updatedAt: '' }
const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const beaVote = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

test('a held vote stays on its chat while another coworker keeps the same answer and its own vote', async () => {
    const writes: { method: string; url: string; body: unknown }[] = []
    let failNext = false
    let holdPut = true
    let releasePut: ((response: Response) => void) | undefined
    let releaseDelete: ((response: Response) => void) | undefined
    const votes = new Map<string, { id: string; messageId: string; rating: string }[]>([[second, [{ id: beaVote, messageId: 'engine-msg-b', rating: 'down' }]]])
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (url.endsWith('/stop')) return Response.json({ running: false })
        const sessionId = url.match(/sessions\/([^/]+)\//)?.[1]
        if (url.endsWith('/messages') && sessionId) {
            const messageId = sessionId === first ? 'engine-msg-a' : 'engine-msg-b'
            return Response.json({ messages: [{ id: messageId, role: 'assistant', parts: [{ type: 'text', text: answer }] }] })
        }
        if (url.includes('/feedback')) {
            const body = init?.body ? JSON.parse(String(init.body)) : null
            writes.push({ method, url, body })
            if (method === 'GET') return Response.json({ votes: votes.get(sessionId ?? '') ?? [] })
            if (method === 'DELETE') {
                if (releaseDelete) return new Promise<Response>(resolve => { releaseDelete = response => { votes.set(sessionId ?? '', []); resolve(response) } })
                votes.set(sessionId ?? '', [])
                return Response.json({ ok: true })
            }
            if (failNext) { failNext = false; return Response.json({ error: 'disk' }, { status: 500 }) }
            if (method === 'PUT' && holdPut) {
                holdPut = false
                return new Promise<Response>(resolve => { releasePut = async response => {
                    votes.set(sessionId ?? '', [await response.clone().json()])
                    resolve(response)
                } })
            }
            if (method === 'PUT') {
                const vote = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', messageId: body.messageId, rating: body.rating }
                votes.set(sessionId ?? '', [vote])
                return Response.json(vote)
            }
            return Response.json({ ok: true })
        }
        if (url.endsWith('/chat')) throw new Error('Rating must not call the model')
        throw new Error('Unexpected request: ' + method + ' ' + url)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    function Harness() {
        const [tab, setTab] = useState<'ada' | 'bea'>('ada')
        const pane = (id: 'ada' | 'bea', agent: typeof ada, sessionId: string) => (
            <div data-pane={id} hidden={tab !== id}>
                <DesktopConversation agent={agent} sessionId={sessionId} active={tab === id} sessions={[{ id: sessionId, agentId: agent.id, title: id, createdAt: '', updatedAt: '' }]} onSelectSession={() => {}} onChatSession={() => {}} />
            </div>
        )
        return <>
            <button type="button" onClick={() => setTab('ada')}>Show Ada</button>
            <button type="button" onClick={() => setTab('bea')}>Show Bea</button>
            {pane('ada', ada, first)}
            {pane('bea', bea, second)}
        </>
    }
    const pane = (id: string) => container.querySelector<HTMLElement>(`[data-pane="${id}"]`)!
    const thumb = (id: string, label: string) => [...pane(id).querySelectorAll('button')].find(button => button.textContent?.includes(label))
    const click = (id: string, label: string) => act(async () => { thumb(id, label)!.click() })
    const show = (label: string) => act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click() })
    try {
        await act(async () => { root.render(<Harness />) })
        expect(pane('ada').textContent).toContain(answer)
        expect(thumb('ada', 'Good response')?.getAttribute('aria-pressed')).toBe('false')
        expect(pane('ada').querySelector('[aria-label="Copy reply"]')).not.toBeNull()
        await click('ada', 'Good response')
        expect(thumb('ada', 'Good response')?.getAttribute('aria-pressed')).toBe('true')
        expect(document.body.textContent).toContain('Give positive feedback')
        await show('Show Bea')
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(pane('bea').textContent).toContain(answer)
        expect(thumb('bea', 'Bad response')?.getAttribute('aria-pressed')).toBe('true')
        expect(thumb('bea', 'Good response')?.getAttribute('aria-pressed')).toBe('false')
        const resolvePut = releasePut!
        releasePut = undefined
        await act(async () => { resolvePut(Response.json({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', messageId: 'engine-msg-a', rating: 'up' })) })
        expect(thumb('bea', 'Bad response')?.getAttribute('aria-pressed')).toBe('true')
        expect(thumb('ada', 'Good response')?.getAttribute('aria-pressed')).toBe('true')
        expect(writes.some(write => write.url.endsWith('/chat'))).toBe(false)

        releaseDelete = () => {}
        await show('Show Ada')
        await click('ada', 'Good response')
        expect(thumb('ada', 'Good response')?.getAttribute('aria-pressed')).toBe('false')
        await show('Show Bea')
        expect(thumb('bea', 'Bad response')?.getAttribute('aria-pressed')).toBe('true')
        const resolveDelete = releaseDelete!
        releaseDelete = undefined
        await act(async () => { resolveDelete(Response.json({ ok: true })) })
        expect(thumb('bea', 'Bad response')?.getAttribute('aria-pressed')).toBe('true')
        await show('Show Ada')
        expect(thumb('ada', 'Good response')?.getAttribute('aria-pressed')).toBe('false')

        failNext = true
        await click('ada', 'Bad response')
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not save your feedback')
        expect(thumb('ada', 'Bad response')?.getAttribute('aria-pressed')).toBe('false')
        await click('ada', 'Bad response')
        expect(thumb('ada', 'Bad response')?.getAttribute('aria-pressed')).toBe('true')
        const dialog = () => document.querySelector('[role="dialog"]')
        expect(dialog()?.textContent).toContain('Feedback is stored on this Mac.')
        expect(dialog()?.textContent).toContain('Give negative feedback')
        expect(dialog()?.textContent).toContain('What type of issue do you wish to report?')
        expect(dialog()?.textContent).not.toContain('shares this conversation')
        const beforeCancel = writes.length
        await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click() })
        expect(dialog()).toBeNull()
        expect(writes.slice(beforeCancel).some(write => write.method === 'DELETE')).toBe(false)
        expect(thumb('ada', 'Bad response')?.getAttribute('aria-pressed')).toBe('true')

        await click('ada', 'Good response')
        expect(writes.at(-1)).toMatchObject({ method: 'PUT', body: { agentId: ada.id, messageId: 'engine-msg-a', rating: 'up' } })
        expect(dialog()?.textContent).toContain('Give positive feedback')
        const details = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="What was satisfying about this response?"]')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(details, 'Kept locally')
            details.dispatchEvent(new Event('input', { bubbles: true }))
            details.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Submit'))!.click() })
        expect(writes.at(-1)).toMatchObject({ method: 'PATCH', body: { agentId: ada.id, category: null, details: 'Kept locally' } })
        expect(dialog()).toBeNull()
        expect(thumb('ada', 'Good response')?.getAttribute('aria-pressed')).toBe('true')
        expect(thumb('bea', 'Bad response')?.getAttribute('aria-pressed')).toBe('true')
    } finally {
        await act(async () => { root.unmount() })
        vi.unstubAllGlobals()
        container.remove()
    }
})
