// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'

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

test('Import file posts one file to the coworker’s current folder and reports a kept duplicate', async () => {
    const posts: { agent: string; path: string; name: string }[] = []
    const base = engineFor({ alice: '', bob: '' })
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
            const form = init.body as FormData
            const file = form.get('file') as File
            const agent = decodeURIComponent(String(input).split('/')[4])
            posts.push({ agent, path: String(form.get('path')), name: file.name })
            return agent === 'bob'
                ? Response.json({ error: `This folder already has a file named “${file.name}”. The existing file was kept; rename yours and import it again.` }, { status: 409 })
                : Response.json({ path: `docs/${file.name}`, name: file.name }, { status: 201 })
        }
        return base(input)
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    for (const id of ['alice', 'bob']) {
        await act(async () => { root.render(<DesktopConversation key={id} agent={coworker(id)} sessionId={null} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />) })
        await click('Files')
        await flush()
        await click('docs')
        await flush()
        const input = document.querySelector<HTMLInputElement>('[data-testid="import-file-input"]')!
        expect(input.accept).toContain('.md')
        expect(input.multiple).toBe(false)
        Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'brief.md')] })
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
        await flush()
        const notice = document.querySelector('[data-testid="import-notice"]')?.textContent
        expect(notice).toBe(id === 'alice' ? 'Imported “brief.md” into docs.' : 'This folder already has a file named “brief.md”. The existing file was kept; rename yours and import it again.')
        await click('Done')
        await flush()
    }
    expect(posts).toEqual([{ agent: 'alice', path: 'docs', name: 'brief.md' }, { agent: 'bob', path: 'docs', name: 'brief.md' }])
    await act(async () => root.unmount())
})
