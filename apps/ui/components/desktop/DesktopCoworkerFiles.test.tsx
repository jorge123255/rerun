// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'
import { FILES_IMPORT_RELOAD_MS } from './files-import/queue'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })
const entry = (name: string, type: 'file' | 'dir') => ({ name, type, size: 1, modifiedAt: '2026-11-03T12:00:00Z' })
const click = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
    expect(button, text).toBeDefined()
    await act(async () => { button!.click() })
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

function engineFor(contents: Record<string, string>) {
    return vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const agent = decodeURIComponent(url.pathname.split('/')[4])
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.includes('/files/read')) return Response.json({ path, content: contents[agent], size: 1, truncated: false })
        if (url.pathname.endsWith('/files')) {
            if (path === '') return Response.json({ path, entries: [entry('docs', 'dir'), ...(url.searchParams.get('hidden') ? [entry('.env', 'file')] : [])] })
            if (path === 'docs') return Response.json({ path, entries: [entry('notes.md', 'file')] })
        }
        return Response.json({ error: 'nope' }, { status: 404 })
    })
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

test('each coworker’s Files browses folders and previews its own identically named file', async () => {
    const fetcher = engineFor({ alice: '# Alice notes', bob: '# Bob notes' })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    for (const [id, expected] of [['alice', '# Alice notes'], ['bob', '# Bob notes']]) {
        await act(async () => { root.render(<DesktopConversation key={id} agent={coworker(id)} sessionId={null} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />) })
        await click('Files')
        await flush()
        await click('docs')
        await flush()
        expect(document.querySelector('nav[aria-label="Folder"]')?.textContent).toContain('docs')
        await click('notes.md')
        await flush()
        expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe(expected)
        expect(fetcher).toHaveBeenCalledWith(`/api/desktop/agents/${id}/files/read?path=docs%2Fnotes.md`, expect.anything())
        await click('Back to folder')
        await click('..')
        await flush()
        await click('Show hidden files')
        await flush()
        expect(document.querySelector('[data-files-name=".env"]')).toBeTruthy()
        await click('Done')
    }
    expect(fetcher.mock.calls.every(([url]) => !String(url).match(/method|PUT|DELETE/))).toBe(true)
    act(() => root.unmount())
})

test('a refused path shows the server’s message instead of contents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/read')
        ? Response.json({ error: 'That path is outside this coworker’s workspace.' }, { status: 400 })
        : Response.json({ path: '', entries: [entry('escape.txt', 'file')] })))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopConversation agent={coworker('alice')} sessionId={null} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />) })
    await click('Files')
    await flush()
    await click('escape.txt')
    await flush()
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('That path is outside this coworker’s workspace.')
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    act(() => root.unmount())
})

test('Import file accepts exact acknowledgements and reports duplicate or unconfirmed writes', async () => {
    const posts: { agent: string; path: string }[] = []
    const clash = 'This folder already has a file named “brief.md”. The existing file was kept; rename yours and import it again.'
    const unconfirmed = 'The file import result could not be confirmed. Check Files before retrying.'
    const base = engineFor({ alice: '', bob: '', carol: '' })
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (init?.method === 'POST' && url.pathname.endsWith('/files/import')) {
            const agent = decodeURIComponent(url.pathname.split('/')[4])
            const path = url.searchParams.get('path') ?? ''
            posts.push({ agent, path })
            if (agent === 'bob') return Response.json({ error: clash, code: 'clash' }, { status: 409 })
            if (agent === 'carol') return Response.json({ saved: false }, { status: 201 })
            return Response.json({ saved: true, path, bytes: 1 }, { status: 201 })
        }
        return base(input)
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    for (const [id, notice] of [['alice', '1 file imported'], ['bob', clash], ['carol', unconfirmed]]) {
        await act(async () => { root.render(<DesktopConversation key={id} agent={coworker(id)} sessionId={null} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />) })
        await click('Files')
        await flush()
        await click('docs')
        await flush()
        const input = document.querySelector<HTMLInputElement>('[data-testid="files-import-file-input"]')!
        expect(input).not.toBeNull()
        Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'brief.md')] })
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
        await flush()
        expect(document.body.textContent).toContain(notice)
        await click('Done')
        await flush()
    }
    expect(posts).toEqual(['alice', 'bob', 'carol'].map(agent => ({ agent, path: 'docs/brief.md' })))
    await act(async () => root.unmount())
})

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

async function openFiles(fetcher: typeof fetch) {
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<DesktopConversation agent={coworker('alice')} sessionId={null} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />))
    await click('Files')
    await flush()
    return () => act(async () => root.unmount())
}

async function pickFiles(...names: string[]) {
    const input = document.querySelector<HTMLInputElement>('[data-testid="files-import-file-input"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: names.map(name => new File(['x'], name)) })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await flush()
}

async function dropFolder() {
    const file = deferred<File>()
    const child = { isFile: true, file: (onFile: (value: File) => void) => { void file.promise.then(onFile) } }
    const folder = {
        isFile: false,
        name: 'incoming',
        createReader() {
            let batch = [child]
            return {
                readEntries(onEntries: (children: typeof batch) => void) {
                    const next = batch
                    batch = []
                    onEntries(next)
                },
            }
        },
    }
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => folder }] },
    })
    await act(async () => document.querySelector('[data-testid="desktop-files-grid"]')!.dispatchEvent(event))
    return async () => {
        file.resolve(new File(['x'], 'brief.md'))
        await flush()
    }
}

test('a folder drop stays scoped to the folder open when it began', async () => {
    const base = engineFor({ alice: '' })
    const posts: string[] = []
    const close = await openFiles(async input => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const path = url.searchParams.get('path') ?? ''
        if (!url.pathname.endsWith('/files/import')) return base(input)
        posts.push(path)
        return Response.json({ saved: true, path }, { status: 201 })
    })
    try {
        await click('docs')
        await flush()
        const finishDrop = await dropFolder()
        await click('Workspace home')
        await flush()
        await finishDrop()
        expect(posts).toEqual(['docs/incoming/brief.md'])
    } finally {
        await close()
    }
})

test('closing Files aborts active imports and clears queued imports', async () => {
    const base = engineFor({ alice: '' })
    const writes: { signal: AbortSignal; path: string }[] = []
    const response = deferred<Response>()
    const close = await openFiles(async (input, init) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (!url.pathname.endsWith('/files/import')) return base(input)
        writes.push({ signal: init!.signal!, path: url.searchParams.get('path')! })
        return response.promise
    })
    try {
        await pickFiles('first.md', 'second.md', 'third.md', 'queued.md')
        expect(writes).toHaveLength(3)
        await click('Done')
        const aborted = writes.map(write => write.signal.aborted)
        response.resolve(Response.json({ saved: false }))
        await flush()
        expect(aborted).toEqual([true, true, true])
        expect(writes.map(write => write.path)).toEqual(['first.md', 'second.md', 'third.md'])
    } finally {
        response.resolve(Response.json({ saved: false }))
        await close()
    }
})

test('a drop still being enumerated when Files closes never starts importing', async () => {
    const base = engineFor({ alice: '' })
    const fetcher = vi.fn(base)
    const close = await openFiles(fetcher)
    try {
        const finishDrop = await dropFolder()
        await click('Done')
        await finishDrop()
        expect(fetcher.mock.calls.some(([input]) => String(input).includes('/files/import'))).toBe(false)
    } finally {
        await close()
    }
})

test('dismiss clears a failed import after offering retry', async () => {
    const base = engineFor({ alice: '' })
    const close = await openFiles(async input => String(input).includes('/files/import')
        ? Response.json({ error: 'File already exists', code: 'clash' }, { status: 409 })
        : base(input))
    try {
        await pickFiles('existing.md')
        const tray = document.querySelector('[data-testid="files-import-tray"]')!
        expect(tray.textContent).toContain('File already exists')
        expect(tray.querySelector('button[title="Retry"]')).not.toBeNull()
        await click('Dismiss')
        expect(document.querySelector('[data-testid="files-import-tray"]')).toBeNull()
    } finally {
        await close()
    }
})

test('a confirmed import does not abandon a folder listing already in flight', async () => {
    const base = engineFor({ alice: '' })
    const docs = deferred<Response>()
    const listCalls: string[] = []
    const close = await openFiles(async input => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.endsWith('/files/import')) return Response.json({ saved: true, path }, { status: 201 })
        if (url.pathname.endsWith('/files')) {
            listCalls.push(path)
            if (path === 'docs') return docs.promise
        }
        return base(input)
    })
    try {
        await pickFiles('brief.md')
        expect(document.body.textContent).toContain('1 file imported')
        await click('docs')
        expect(listCalls).toEqual(['', 'docs'])
        await act(async () => { await new Promise(resolve => setTimeout(resolve, FILES_IMPORT_RELOAD_MS + 20)) })
        docs.resolve(Response.json({ path: 'docs', entries: [entry('notes.md', 'file')] }))
        await flush()
        expect(listCalls).toEqual(['', 'docs'])
        expect(document.querySelector('[data-files-name="notes.md"]')).not.toBeNull()
    } finally {
        docs.resolve(Response.json({ path: 'docs', entries: [] }))
        await close()
    }
})

test('a confirmed import refreshes the folder when it remains open', async () => {
    const base = engineFor({ alice: '' })
    let saved = false
    const close = await openFiles(async input => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.endsWith('/files/import')) {
            saved = true
            return Response.json({ saved: true, path }, { status: 201 })
        }
        if (saved && url.pathname.endsWith('/files') && path === '') {
            return Response.json({ path, entries: [entry('brief.md', 'file')] })
        }
        return base(input)
    })
    try {
        await pickFiles('brief.md')
        expect(document.querySelector('[data-files-name="brief.md"]')).toBeNull()
        await act(async () => { await new Promise(resolve => setTimeout(resolve, FILES_IMPORT_RELOAD_MS + 20)) })
        expect(document.querySelector('[data-files-name="brief.md"]')).not.toBeNull()
    } finally {
        await close()
    }
})

test('refresh replaces a text thumbnail when only the listed modification time changes', async () => {
    vi.stubGlobal('IntersectionObserver', class {
        constructor(private readonly notify: IntersectionObserverCallback) {}
        observe() { this.notify([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
        disconnect() {}
    })
    const original = deferred<Response>()
    const file = { ...entry('brief.md', 'file'), size: 4, identity: '12:34' }
    const heads = ['old!', 'new!', 'last']
    let revision = 0
    const reads: number[] = []
    const close = await openFiles(async input => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/files/read')) {
            reads.push(revision)
            return revision === 0 ? original.promise : Response.json({ content: heads[revision] })
        }
        if (url.pathname.endsWith('/files')) {
            return Response.json({ entries: [{ ...file, modifiedAt: `2026-11-03T12:00:0${revision}.000Z` }] })
        }
        return Response.json({ error: 'Unexpected request' }, { status: 404 })
    })
    const thumbnail = () => document.querySelector('[data-files-name="brief.md"] pre')?.textContent
    try {
        expect(reads).toEqual([0])
        expect(thumbnail()).toBeUndefined()
        revision = 1
        await click('Refresh files')
        await flush()
        expect(thumbnail()).toBe('new!')

        original.resolve(Response.json({ content: heads[0] }))
        await flush()
        expect(thumbnail()).toBe('new!')

        revision = 2
        await click('Refresh files')
        await flush()
        expect(thumbnail()).toBe('last')
        expect(reads).toEqual([0, 1, 2])
    } finally {
        original.resolve(Response.json({ content: heads[0] }))
        await close()
    }
})
