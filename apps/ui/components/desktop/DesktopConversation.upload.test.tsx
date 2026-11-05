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

test('send waits for file validation before an import job exists', async () => {
    let release!: (bytes: ArrayBuffer) => void
    const chosen = txt('checking.txt')
    Object.defineProperty(chosen, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { release = resolve }) })
    const { posts, imports } = stubFetch()
    await render('saved')
    await writeDraft('Read the chosen file')
    await pickFiles([chosen])
    await flush()
    expect(imports).toEqual([])
    await submitComposer()
    expect(posts).toEqual([])
    await act(async () => release(new TextEncoder().encode('hello').buffer))
    await flush(); await flush()
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'Read the chosen file', attachmentPath: 'checking.txt' }])
})

test('closing a conversation cancels a pending send even when the import response arrives later', async () => {
    let finish!: () => void
    const { posts } = stubFetch({ imports: name => new Promise<Response>(resolve => { finish = () => resolve(Response.json({ path: name, name }, { status: 201 })) }) })
    await render('first')
    await writeDraft('This must not be sent after close')
    await pickFiles([txt('late.txt')]); await flush()
    await submitComposer()
    await render('second')
    await flush()
    await act(async () => finish())
    await flush(); await flush()
    expect(posts).toEqual([])
    expect(titles()).not.toContain('late.txt')
})

test('a durable draft sent after uploading clears the acknowledged version, not the pre-upload version', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'wait-durable', id: 'saved' }])
    let finish!: () => void
    const { posts } = stubFetch({ draft: fixture, imports: name => new Promise<Response>(resolve => { finish = () => resolve(Response.json({ path: name, name }, { status: 201 })) }) })
    await renderTab('wait-durable'); await flush()
    await writeDraft('Save and send this attachment')
    await pickFiles([txt('durable.txt')]); await flush()
    await submitComposer()
    await act(async () => finish())
    for (let attempt = 0; attempt < 8; attempt++) await flush()
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'Save and send this attachment', attachmentPath: 'durable.txt' }])
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(titles()).not.toContain('durable.txt')
    const saved = fixture.handle('/api/desktop/agents/alice/draft?tabUid=wait-durable')!
    expect((await saved.json()).draft).toMatchObject({ text: '' })
    expect((await fixture.handle('/api/desktop/agents/alice/upload-attempts?tabUid=wait-durable')!.json()).attempts).toEqual([])
})

test('an uncertain imported file hydrates after remount and is never silently retried or attached', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'uncertain-tab', id: 'saved' }])
    const { imports, posts } = stubFetch({ draft: fixture, imports: () => Promise.reject(new Error('Lost accepted response')) })
    await renderTab('uncertain-tab'); await flush()
    await writeDraft('Keep this text')
    await pickFiles([txt('unknown.txt')]); await flush(); await flush()
    expect(imports).toEqual(['unknown.txt'])
    await act(async () => root.unmount())
    forgetCoworkerDrafts('alice')
    root = createRoot(container)
    await renderTab('uncertain-tab'); await flush(); await flush()
    expect(document.body.textContent).toContain('Unresolved upload:')
    expect(button('Retry import unknown.txt')).toBeUndefined()
    await submitComposer(); await flush()
    expect(posts).toEqual([])
    expect(imports).toEqual(['unknown.txt'])
    expect(container.querySelector('textarea')!.value).toBe('Keep this text')
    await click('Remove upload unknown.txt'); await flush()
    await submitComposer(); await flush()
    expect(posts).toEqual([{ agentId: 'alice', sessionId: 'saved', text: 'Keep this text' }])
})

test('a failed durable warning write prevents the file POST entirely', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'no-warning', id: 'saved' }])
    const { imports } = stubFetch({ draft: fixture })
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST' && String(input).includes('/upload-attempts')) return Response.json({ error: 'Storage unavailable' }, { status: 500 })
        return base(input, init)
    }))
    await renderTab('no-warning'); await flush()
    await pickFiles([txt('never-posted.txt')]); await flush(); await flush()
    expect(imports).toEqual([])
    expect(document.body.textContent).toContain('could not be confirmed')
})

test('retry rechecks the current attachment budget after other files filled the last slot', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => 'existing-' + i + '.txt')
    const { imports } = stubFetch({
        filesGet: () => Response.json({ entries: [...paths, 'last.txt'].map(name => ({ name, type: 'file', size: 1 })) }),
        imports: name => name === 'refused.txt' ? Response.json({ error: 'Name exists' }, { status: 409 }) : Response.json({ path: name, name }, { status: 201 }),
    })
    await act(async () => root.render(<DesktopConversation agent={agent} sessionId="saved" sessions={[]} initialDraft={{ text: '', attachments: paths }} onSelectSession={() => {}} onChatSession={() => {}} />))
    await pickFiles([txt('refused.txt')]); await flush()
    await pickFiles([txt('last.txt')]); await flush()
    await click('Retry import refused.txt'); await flush()
    expect(imports).toEqual(['refused.txt', 'last.txt'])
    expect(document.body.textContent).toContain('10 files')
})

test('closing and reopening the same mounted chat cancels its waiting send and restores the uncertain status', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'parked', id: 'saved' }])
    let finish!: () => void
    const { imports, posts } = stubFetch({ draft: fixture, imports: name => new Promise<Response>(resolve => { finish = () => resolve(Response.json({ path: name, name }, { status: 201 })) }) })
    const show = (active: boolean) => act(async () => root.render(<DesktopConversation agent={agent} sessionId="saved" sessions={[]} tabUid="parked" active={active} onSelectSession={() => {}} onChatSession={() => {}} />))
    await show(true); await flush()
    await writeDraft('Keep the waiting message')
    await pickFiles([txt('parked.txt')]); await flush()
    await submitComposer()
    await show(false); await flush()
    await show(true); await flush()
    await act(async () => finish()); await flush(); await flush()
    expect(posts).toEqual([])
    expect(imports).toEqual(['parked.txt'])
    expect(document.body.textContent).toContain('Unresolved upload:')
    expect(container.querySelector('textarea')!.value).toBe('Keep the waiting message')
})

test('an upload joins the exact queued message only after validation, import and draft acknowledgment', async () => {
    const fixture = createDesktopDraftFixture()
    fixture.seedTabs('alice', [{ uid: 'queue-upload', id: 'saved' }])
    let finish!: () => void
    const { posts } = stubFetch({ draft: fixture, imports: name => new Promise<Response>(resolve => { finish = () => resolve(Response.json({ path: name, name }, { status: 201 })) }) })
    const base = vi.mocked(fetch).getMockImplementation()!
    const writes: Array<{ action: string; item?: Record<string, unknown> }> = []
    let queued: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), 'http://local').pathname
        if (pathname.endsWith('/stop')) return Response.json({ running: true, runId: 'active-run' })
        if (pathname.endsWith('/queue')) {
            if (init?.method === 'PUT') {
                const change = JSON.parse(String(init.body))
                writes.push(change)
                if (change.action === 'enqueue') queued = change.item
            }
            return Response.json({ queued })
        }
        return base(input, init)
    }))
    await renderTab('queue-upload'); await flush()
    await writeDraft('Use this in the next reply')
    await pickFiles([txt('queued.txt')]); await flush()
    await submitComposer()
    expect(writes).toEqual([])
    await act(async () => finish())
    for (let attempt = 0; attempt < 8; attempt++) await flush()
    expect(posts).toEqual([])
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ action: 'enqueue', item: { text: 'Use this in the next reply', attachmentPath: 'queued.txt', behindRunId: 'active-run' } })
    expect(container.querySelector('textarea')!.value).toBe('')
})
