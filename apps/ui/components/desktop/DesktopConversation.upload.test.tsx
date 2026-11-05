// @vitest-environment happy-dom
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
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const button = (label: string) => [...document.querySelectorAll('button')].find(el => el.textContent?.trim() === label || el.getAttribute('aria-label') === label)
async function click(label: string) {
    expect(button(label), label).toBeDefined()
    await act(async () => { button(label)!.click() })
}
const agent = { id: 'alice', name: 'alice', description: '', createdAt: '', updatedAt: '' }
const render = (sessionId: string | null) => act(async () => {
    root.render(<DesktopConversation key={sessionId ?? 'new'} agent={agent} sessionId={sessionId} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />)
})
const renderTab = (tabUid: string) => act(async () => {
    root.render(<DesktopConversation agent={agent} sessionId="saved" sessions={[]} tabUid={tabUid} onSelectSession={() => {}} onChatSession={() => {}} />)
})
const writeDraft = (text: string) => act(async () => {
    const el = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
})
const submitComposer = () => act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
})
const pickFiles = (files: File[]) => act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
})
const txt = (name: string, content = 'hello') => new File([content], name, { type: 'text/plain' })
const titles = () => [...container.querySelectorAll<HTMLElement>('span[title]')].map(node => node.title)
const importedName = (init?: RequestInit) => {
    const file = init?.body instanceof FormData ? init.body.get('file') : null
    return file instanceof File ? file.name : ''
}

function stubFetch(overrides: {
    imports?: (name: string) => Response | Promise<Response>
    filesGet?: (path: string | null) => Response
    draft?: ReturnType<typeof createDesktopDraftFixture>
    observe?: (input: RequestInfo | URL, init?: RequestInit) => void
} = {}) {
    const posts: Record<string, unknown>[] = []
    const imports: string[] = []
    const fixture = overrides.draft ?? null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        overrides.observe?.(input, init)
        const url = new URL(String(input), 'http://local')
        const draftResponse = fixture?.handle(input, init)
        if (draftResponse) return draftResponse
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/files')) {
            if (init?.method === 'POST' && init.body instanceof FormData) {
                const name = importedName(init)
                imports.push(name)
                return overrides.imports ? overrides.imports(name) : Response.json({ path: name, name }, { status: 201 })
            }
            return overrides.filesGet ? overrides.filesGet(url.searchParams.get('path')) : Response.json({ entries: [] })
        }
        if (url.pathname.endsWith('/chat')) {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>
            posts.push(body)
            return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': 'saved' } })
        }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        return Response.json({ running: false })
    }))
    return { posts, imports }
}

test('picked files import one at a time in selection order and travel as ordered paths', async () => {
    const pending: Array<() => void> = []
    const { posts, imports } = stubFetch({
        imports: name => new Promise<Response>(resolve => pending.push(() => resolve(Response.json({ path: name, name }, { status: 201 })))),
    })
    await render('saved')
    await pickFiles([txt('b.txt'), txt('a.md', '# note')])
    await flush()
    expect(imports).toEqual(['b.txt'])
    await act(async () => { pending.shift()!() })
    await flush()
    expect(imports).toEqual(['b.txt', 'a.md'])
    await act(async () => { pending.shift()!() })
    await flush()
    expect(titles()).toEqual(expect.arrayContaining(['b.txt', 'a.md']))
    await writeDraft('Read both files')
    await click('Send')
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'Read both files', attachmentPaths: ['b.txt', 'a.md'] }])
})

test('a mixed selection imports only the valid files and names the refused ones', async () => {
    const { imports } = stubFetch()
    await render('saved')
    await pickFiles([txt('photo.png', 'x'), txt('good.txt'), new File([new Uint8Array(33 * 1024)], 'huge.txt'), txt('notes.md')])
    await flush()
    expect(imports).toEqual(['good.txt', 'notes.md'])
    const notice = [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' ')
    expect(notice).toContain('photo.png')
    expect(notice).toContain('huge.txt')
    expect(notice).not.toContain('good.txt')
    expect(titles()).toEqual(expect.arrayContaining(['good.txt', 'notes.md']))
})

test('a definitive refusal stays retryable, blocks the send, and recovers by removal', async () => {
    const { posts } = stubFetch({
        imports: name => name === 'clash.txt'
            ? Response.json({ error: 'This folder already has a file named “clash.txt”.' }, { status: 409 })
            : Response.json({ path: name, name }, { status: 201 }),
    })
    await render('saved')
    await pickFiles([txt('fine.txt'), txt('clash.txt')])
    await flush()
    expect(titles()).toEqual(expect.arrayContaining(['fine.txt', 'clash.txt']))
    await writeDraft('send it')
    await click('Send')
    expect(posts).toEqual([])
    expect(document.body.textContent).toContain('failed to import')
    expect(button('Retry import clash.txt')).toBeDefined()
    await click('Remove upload clash.txt')
    await click('Send')
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'send it', attachmentPath: 'fine.txt' }])
})

test('an unreadable import outcome stays unresolved, is never retried, and points at Files', async () => {
    const { posts } = stubFetch({
        imports: () => Promise.reject(new TypeError('network down')),
    })
    await render('saved')
    await pickFiles([txt('maybe.txt')])
    await flush()
    expect(document.body.textContent).toContain('could not be confirmed')
    expect(button('Retry import maybe.txt')).toBeUndefined()
    await writeDraft('send it')
    await click('Send')
    expect(posts).toEqual([])
    expect(document.body.textContent).toContain('may already be in this coworker’s Files')
    await click('Remove upload maybe.txt')
    await click('Send')
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'send it' }])
})

test('a send during an in-flight import waits for the confirmed path', async () => {
    const pending: Array<() => void> = []
    const { posts } = stubFetch({
        imports: name => new Promise<Response>(resolve => pending.push(() => resolve(Response.json({ path: name, name }, { status: 201 })))),
    })
    await render('saved')
    await pickFiles([txt('wait.txt')])
    await flush()
    await writeDraft('wait for it')
    await submitComposer()
    await flush()
    expect(posts).toEqual([])
    await act(async () => { pending.shift()!() })
    await flush()
    await flush()
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'wait for it', attachmentPath: 'wait.txt' }])
})

test('an owner change mid-import drops the job without leaking it into the next conversation', async () => {
    const pending: Array<() => void> = []
    stubFetch({
        imports: name => new Promise<Response>(resolve => pending.push(() => resolve(Response.json({ path: name, name }, { status: 201 })))),
    })
    await render('first')
    await pickFiles([txt('owned.txt')])
    await flush()
    await render('second')
    await act(async () => { pending.shift()!() })
    await flush()
    expect(titles()).not.toContain('owned.txt')
    expect(document.body.textContent).not.toContain('owned.txt')
})

test('confirmed uploads persist as ordered draft attachments and survive a remount', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'upload-tab', id: 'saved' }])
    const writes: Record<string, unknown>[] = []
    stubFetch({
        draft: fixture,
        observe: (input, init) => {
            if (init?.method === 'PUT' && new URL(String(input), 'http://local').pathname.endsWith('/draft')) {
                writes.push(JSON.parse(String(init.body)))
            }
        },
    })
    await renderTab('upload-tab')
    await flush()
    await pickFiles([txt('one.txt'), txt('two.md', '# two')])
    for (let attempt = 0; attempt < 10 && (writes.at(-1)?.attachmentPaths as string[] | undefined)?.length !== 2; attempt++) await flush()
    expect(writes.at(-1)).toMatchObject({ attachmentPaths: ['one.txt', 'two.md'] })
    await act(async () => root.unmount())
    forgetCoworkerDrafts('alice')
    root = createRoot(container)
    await renderTab('upload-tab')
    await flush()
    await flush()
    expect(titles()).toEqual(expect.arrayContaining(['one.txt', 'two.md']))
})

test('a draft that cannot take a confirmed import keeps the file visibly unresolved', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'broken-tab', id: 'saved' }])
    const pending: Array<() => void> = []
    stubFetch({
        draft: fixture,
        imports: name => new Promise<Response>(resolve => pending.push(() => resolve(Response.json({ path: name, name }, { status: 201 })))),
    })
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT' && new URL(String(input), 'http://local').pathname.endsWith('/draft')) {
            return Response.json({ error: 'Draft store unavailable' }, { status: 500 })
        }
        return base(input, init)
    }))
    await renderTab('broken-tab')
    await flush()
    await pickFiles([txt('orphan.txt')])
    await flush()
    await writeDraft('keep this text')
    await flush()
    await flush()
    await flush()
    await act(async () => { pending.shift()!() })
    await flush()
    await flush()
    expect(document.body.textContent).toContain('could not take it')
    expect(document.body.textContent).toContain('Attach it from Files instead')
})
