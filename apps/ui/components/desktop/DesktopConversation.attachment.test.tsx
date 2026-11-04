// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})
afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    vi.unstubAllGlobals()
})
const path = 'docs/notes.md'
const entry = (name: string, type = 'file', size = 10) => ({ name, type, size })
const button = (label: string) => [...document.querySelectorAll('button')].find(el => el.textContent?.trim() === label || el.getAttribute('aria-label') === label)
async function click(label: string) {
    expect(button(label), label).toBeDefined()
    await act(async () => { button(label)!.click() })
}
const render = (agentId: string, sessionId: string | null) => act(async () => {
    const agent = { id: agentId, name: agentId, description: '', createdAt: '', updatedAt: '' }
    root.render(<DesktopConversation key={agentId} agent={agent} sessionId={sessionId} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />)
})
const writeDraft = (text: string) => act(async () => {
    const el = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
})

test('a scoped picker supports retry, folders, removal, and rejects a second or unsupported attachment', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/files')) {
            expect(url.pathname).toBe('/api/desktop/agents/alice/files')
            if (fail) return Response.json({ error: 'Folder unavailable' }, { status: 502 })
            const entries = url.searchParams.get('path') === 'docs' ? [entry('notes.md'), entry('new.txt')] : [entry('docs','dir'), entry('photo.png'),entry('long.txt','file',32769)]
            return Response.json({ entries })
        }
        return Response.json(url.pathname.endsWith('/messages') ? { messages: [] } : { running: false })
    }))
    await render('alice','first')
    await click('Attach from Files')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Folder unavailable')
    fail = false
    await click('Retry files')
    expect(button('photo.pngText or Markdown only')?.disabled).toBe(true)
    expect(button('long.txtToo large')?.disabled).toBe(true)
    await click('docs')
    await click('notes.md')
    expect(button('Remove attachment notes.md')).toBeDefined()
    expect(button('Send')!.disabled).toBe(true)
    await click('Attach from Files')
    await click('docs')
    await click('new.txt')
    expect(button('Remove attachment notes.md')).toBeUndefined()
    expect(button('Remove attachment new.txt')).toBeDefined()
    await render('alice','second')
    expect(button('Remove attachment new.txt')).toBeUndefined()
    await render('alice','first')
    await click('Remove attachment new.txt')
    expect(button('Remove attachment new.txt')).toBeUndefined()
})

test('sending a workspace file keeps the draft for retry and renders only its saved filename', async () => {
    const text = 'What does the file say?'
    const posts: unknown[] = []
    let accepted = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/files')) return Response.json({ entries: url.searchParams.get('path') ? [entry('notes.md')] : [entry('docs','dir')] })
        if (url.pathname.endsWith('/chat')) {
            posts.push(JSON.parse(String(init?.body)))
            if (!accepted) return Response.json({ error: 'The selected file is no longer available.' }, { status: 404 })
            return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'saved' } })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: !accepted ? [] : [{ id: 'question', role: 'user', parts: [{ type:'text', text }], metadata: { attachmentPath: path } }] })
        return Response.json({ running: false })
    }))
    await render('alice',null)
    await click('Attach from Files')
    await click('docs')
    await click('notes.md')
    await writeDraft(text)
    await click('Send')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The selected file is no longer available.')
    expect(container.querySelector('textarea')!.value).toBe(text)
    expect(button('Remove attachment notes.md')).toBeDefined()
    accepted = true
    await click('Send')
    expect(posts).toEqual(Array(2).fill({ agentId: 'alice', text, attachmentPath: path }))
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(button('Remove attachment notes.md')).toBeUndefined()
    await render('alice','saved')
    expect(container.querySelector('[title="docs/notes.md"]')?.textContent).toContain('notes.md')
    expect(container.textContent).toContain(text)
})

test('stale folder failures do not replace a more recent listing or reopen a dismissed picker', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (!url.pathname.endsWith('/files')) return Response.json({ running: false })
        if (url.pathname.includes('/bob/')) return Response.json({ entries: [entry('bob.md')] })
        return url.searchParams.has('hidden')
            ? Response.json({ entries: [entry('alice.md')] })
            : new Promise<Response>(resolve => { finish = resolve })
    }))
    await render('alice',null)
    await click('Attach from Files')
    await click('Show hidden files')
    await act(async () => { finish(Response.json({ error: 'Old request failed' }, { status: 502 })) })
    expect(button('alice.md')).toBeDefined()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await click('Hide hidden files')
    await click('Cancel')
    await render('bob',null)
    await click('Attach from Files')
    await act(async () => { finish(Response.json({ entries: [entry('stale.md')] })) })
    expect(button('stale.md')).toBeUndefined()
    expect(button('bob.md')).toBeDefined()
})
