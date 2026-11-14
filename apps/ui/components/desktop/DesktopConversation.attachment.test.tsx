// @vitest-environment happy-dom
import { desktopNativeReviewRead } from '@/test/desktop-background-fixture'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
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
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const render = (agentId: string, sessionId: string | null) => act(async () => {
    const agent = { id: agentId, name: agentId, description: '', createdAt: '', updatedAt: '' }
    root.render(<DesktopConversation key={agentId} agent={agent} sessionId={sessionId} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />)
})
const writeDraft = (text: string) => act(async () => {
    const el = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
})

test('a scoped picker supports retry, folders, ordered multi-selection, removal, and unsupported files', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const nativeReview = desktopNativeReviewRead(input); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
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
    await click('Done')
    expect(button('Remove attachment notes.md')).toBeDefined()
    expect(button('Send')!.disabled).toBe(false)
    await click('Attach from Files')
    await click('docs')
    await click('new.txt')
    await click('Done')
    const picks = [...container.querySelectorAll<HTMLElement>('span[title]')].map(node => node.title).filter(path => path.startsWith('docs/'))
    expect(picks).toEqual(['docs/notes.md', 'docs/new.txt'])
    await render('alice','second')
    expect(button('Remove attachment notes.md')).toBeUndefined()
    await render('alice','first')
    await click('Remove attachment notes.md')
    expect(button('Remove attachment notes.md')).toBeUndefined()
    expect(button('Remove attachment new.txt')).toBeDefined()
    await click('Remove attachment new.txt')
    expect(button('Send')!.disabled).toBe(true)
})

test('sending a workspace file keeps the draft for retry and renders only its saved filename', async () => {
    const text = 'What does the file say?'
    const posts: unknown[] = []
    let accepted = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const nativeReview = desktopNativeReviewRead(input, init); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
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
    await click('Done')
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
        const nativeReview = desktopNativeReviewRead(input); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
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

test('a follow-up attachment can be removed while streaming without changing the attachment already sent', async () => {
    const posts: Record<string, unknown>[] = []
    let queued: Record<string, unknown> | null = null
    let accept!: (response: Response) => void
    let finish!: () => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const nativeReview = desktopNativeReviewRead(input, init); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) {
            if (init?.method === 'PUT') queued = JSON.parse(String(init.body)).item
            return Response.json({ queued })
        }
        if (url.pathname.endsWith('/files')) return Response.json({ entries: [entry('original.md'), entry('followup.md')] })
        if (url.pathname.endsWith('/chat')) {
            posts.push(JSON.parse(String(init?.body)))
            return new Promise<Response>(resolve => { accept = resolve })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        return Response.json({ running: false })
    }))
    await render('alice', 'saved')
    await click('Attach from Files'); await click('original.md'); await click('Done')
    await writeDraft('Read the original file'); await click('Send')
    expect(button('Remove attachment original.md')!.disabled).toBe(true)
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'Read the original file', attachmentPath: 'original.md' }])
    await act(async () => {
        const encoder = new TextEncoder()
        accept(new Response(new ReadableStream({ start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"start","messageId":"reply"}\n\ndata: {"type":"text-start","id":"text"}\n\ndata: {"type":"text-delta","id":"text","delta":"Working"}\n\n'))
            finish = () => {
                controller.enqueue(encoder.encode('data: {"type":"text-end","id":"text"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n'))
                controller.close()
            }
        } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': 'saved', 'x-run-id': 'run-original' } }))
    })
    await click('Attach from Files'); await click('followup.md'); await click('Done')
    expect(button('Remove attachment followup.md')!.disabled).toBe(false)
    await click('Remove attachment followup.md')
    expect(button('Remove attachment followup.md')).toBeUndefined()
    await writeDraft('A follow-up without a file'); await click('Send')
    expect(queued).toMatchObject({ text: 'A follow-up without a file', behindRunId: 'run-original' })
    expect(queued).not.toHaveProperty('attachmentPath')
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'Read the original file', attachmentPath: 'original.md' }])
    await act(async () => { finish() })
})

test('three ordered files travel as one immutable set, persist per tab, and render from history', async () => {
    const files = [entry('a.md'), entry('b.md'), entry('c.md')]
    const previews: string[] = []
    const savedContent = 'Original <svg>literal</svg>'
    const textResponse = (content: string) => new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    const posts: Record<string, unknown>[] = []
    const draftWrites: Record<string, unknown>[] = []
    const draftFixture = createDesktopDraftFixture()
    draftFixture.seedTabs('alice', [{ uid: 'tab', id: 'saved' }])
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const nativeReview = desktopNativeReviewRead(input, init); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        const fixture = draftFixture.handle(input, init)
        if (fixture) {
            if (init?.method === 'PUT') draftWrites.push(JSON.parse(String(init.body)))
            return fixture
        }
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/files/read') || url.pathname.endsWith('/attachment')) {
            previews.push(url.pathname + url.search)
            return textResponse(url.pathname.endsWith('/files/read') ? 'Current workspace draft' : savedContent)
        }
        if (url.pathname.endsWith('/files')) return Response.json({ entries: url.searchParams.get('path') === 'docs' ? files : [entry('docs', 'dir')] })
        if (url.pathname.endsWith('/chat')) {
            posts.push(JSON.parse(String(init?.body)))
            return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'saved' } })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: posts.length ? [{
            id: 'engine-multi-user', role: 'user', parts: [{ type: 'text', text: 'Compare the three files' }],
            metadata: { attachmentPaths: ['docs/a.md', 'docs/b.md', 'docs/c.md'] },
        }] : [] })
        return Response.json({ running: false })
    }))
    const agent = { id: 'alice', name: 'alice', description: '', createdAt: '', updatedAt: '' }
    const renderTab = () => act(async () => root.render(
        <DesktopConversation key={`${Date.now()}`} agent={agent} sessionId="saved" sessions={[]} tabUid="tab"
            onSelectSession={() => {}} onChatSession={() => {}} />,
    ))
    await renderTab()
    await flush()
    await click('Attach from Files')
    await click('docs')
    await click('a.md')
    await click('b.md')
    await click('c.md')
    await click('Done')
    expect([...container.querySelectorAll<HTMLElement>('span[title^="docs/"]')].map(node => node.title))
        .toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
    expect(draftWrites.at(-1)).toMatchObject({ text: '', attachmentPaths: ['docs/a.md', 'docs/b.md', 'docs/c.md'] })
    expect(draftWrites.at(-1)).not.toHaveProperty('attachmentPath')

    // A remount reads the persisted ordered set from the same coworker/tab.
    await act(async () => root.unmount())
    forgetCoworkerDrafts('alice')
    root = createRoot(container)
    await renderTab()
    await flush()
    expect([...container.querySelectorAll<HTMLElement>('span[title^="docs/"]')].map(node => node.title))
        .toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])

    await click('Preview a.md')
    expect(document.querySelector('[role="dialog"] pre')?.textContent).toBe('Current workspace draft')
    expect(previews).toEqual(['/api/desktop/agents/alice/files/read?view=attachment&path=docs%2Fa.md'])
    await click('Close')
    expect(posts).toHaveLength(0)

    await writeDraft('Compare the three files')
    await click('Send')
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'Compare the three files', attachmentPaths: ['docs/a.md', 'docs/b.md', 'docs/c.md'] }])
    expect(posts[0]).not.toHaveProperty('attachmentPath')
    await act(async () => root.unmount())
    forgetCoworkerDrafts('alice')
    root = createRoot(container)
    await renderTab()
    await click('Preview a.md')
    expect(document.querySelector('[role="dialog"] pre')?.textContent).toBe(savedContent)
    expect(document.querySelector('[role="dialog"] pre svg')).toBeNull()
    expect(previews.at(-1)).toBe('/api/desktop/sessions/saved/messages/multi-user/attachment?path=docs%2Fa.md')
    await click('Next attachment')
    expect(previews.at(-1)).toBe('/api/desktop/sessions/saved/messages/multi-user/attachment?path=docs%2Fb.md')
    await click('Close')
    expect([...container.querySelectorAll<HTMLElement>('span[title^="docs/"]')].map(node => node.title))
        .toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
})

test('the picker stops at ten files and at the shared 128 KiB total', async () => {
    const ten = Array.from({ length: 11 }, (_, index) => entry(`${index}.md`))
    const heavy = Array.from({ length: 5 }, (_, index) => entry(`big-${index}.md`, 'file', 32768))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const nativeReview = desktopNativeReviewRead(input); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/files')) return Response.json({ entries: url.searchParams.get('path') === 'many' ? ten : url.searchParams.get('path') === 'heavy' ? heavy : [entry('many', 'dir'), entry('heavy', 'dir')] })
        return Response.json(url.pathname.endsWith('/messages') ? { messages: [] } : { running: false })
    }))
    const agent = { id: 'alice', name: 'alice', description: '', createdAt: '', updatedAt: '' }
    await act(async () => root.render(<DesktopConversation agent={agent} sessionId="saved" sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />))
    await click('Attach from Files'); await click('many')
    for (let index = 0; index < 10; index++) await click(`${index}.md`)
    expect(button('10.mdUp to 10 files')?.disabled).toBe(true)
    await click('Cancel')

    await click('Attach from Files'); await click('heavy')
    await click('big-0.md'); await click('big-1.md'); await click('big-2.md'); await click('big-3.md')
    expect(button('big-4.mdOver 128 KiB total')?.disabled).toBe(true)
})

test('a failing multi-file send keeps every chip and the typed text', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const nativeReview = desktopNativeReviewRead(input); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/chat')) return Response.json({ error: '“docs/b.md” was renamed or replaced.' }, { status: 409 })
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        return Response.json({ running: false })
    }))
    const agent = { id: 'alice', name: 'alice', description: '', createdAt: '', updatedAt: '' }
    await act(async () => root.render(<DesktopConversation agent={agent} sessionId="saved" sessions={[]}
        initialDraft={{ text: 'Compare both files', attachments: ['docs/a.md', 'docs/b.md'] }}
        onSelectSession={() => {}} onChatSession={() => {}} />))
    await click('Send')
    expect(container.textContent).toContain('renamed or replaced')
    expect(container.querySelector('textarea')!.value).toBe('Compare both files')
    expect(button('Remove attachment a.md')).toBeDefined()
    expect(button('Remove attachment b.md')).toBeDefined()
})

test('a rejected attachment draft keeps its text and permits removing the rejected file before saving again', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'repair-tab', id: 'saved' }])
    const writes: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const nativeReview = desktopNativeReviewRead(input, init); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/draft') && init?.method === 'PUT') {
            const body = JSON.parse(String(init.body))
            writes.push(body)
            if (body.attachmentPaths?.includes('bad.md')) return Response.json({ code: 'draft_attachment_rejected', error: 'This file is no longer available.' }, { status: 404 })
        }
        const response = fixture.handle(input, init)
        if (response) return response
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/files')) return Response.json({ entries: [entry('good.md'), entry('bad.md')] })
        return Response.json(url.pathname.endsWith('/messages') ? { messages: [] } : { running: false })
    }))
    const agent = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
    const renderTab = () => act(async () => root.render(<DesktopConversation agent={agent} sessionId="saved" tabUid="repair-tab" sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />))
    await renderTab(); await flush()
    await writeDraft('Please preserve this message')
    await click('Attach from Files'); await click('good.md'); await click('bad.md'); await click('Done')
    expect(container.textContent).toContain('This file is no longer available.')
    expect(container.querySelector('textarea')!.value).toBe('Please preserve this message')
    expect(button('Attach from Files')!.disabled).toBe(false)
    const rejected = writes.at(-1)!
    await click('Remove attachment bad.md'); await flush()
    expect(container.textContent).not.toContain('This file is no longer available.')
    expect(writes.at(-1)).toMatchObject({ text: 'Please preserve this message', attachmentPath: 'good.md', baseRevision: rejected.baseRevision })
    expect(writes.at(-1)!.requestId).not.toBe(rejected.requestId)
    expect(button('Remove attachment bad.md')).toBeUndefined()
    await act(async () => root.unmount()); forgetCoworkerDrafts('alice'); root = createRoot(container)
    await renderTab(); await flush()
    expect(container.querySelector('textarea')!.value).toBe('Please preserve this message')
    expect(button('Remove attachment good.md')).toBeDefined()
    expect(button('Remove attachment bad.md')).toBeUndefined()
})
