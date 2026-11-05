// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopFileCard } from './DesktopFileCard'
import type { FileCardEntry } from '@rerun/contracts'
import { composerTestPng } from '@/lib/desktop/server/composer-image.test-fixtures'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const png = composerTestPng
const pdf = (name: string, identity: string, path = `reports/${name}`): FileCardEntry => ({ path, name, size: 1024, scope: 'agent', identity })
const image = (): FileCardEntry => ({ path: 'shots/photo.png', name: 'photo.png', size: png().byteLength, scope: 'agent', identity: '3:1' })

let root: Root | undefined
const calls: { url: URL; signal: AbortSignal | null | undefined }[] = []
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const frame = () => document.querySelector<HTMLImageElement>('[data-testid="file-pdf-preview"]')

function deferred<T>() {
    let resolve!: (value: T) => void
    return { promise: new Promise<T>(done => { resolve = done }), resolve }
}

function page(url: URL) {
    const pageNumber = Number(url.searchParams.get('page') ?? '1')
    return new Response(new Uint8Array(png()).buffer, { headers: {
        'content-type': 'image/png', 'x-pdf-page': String(pageNumber), 'x-pdf-pages': '2', 'x-pdf-width': '1', 'x-pdf-height': '1',
    } })
}

function installFetch(handler?: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push({ url, signal: init?.signal })
        if (handler) return Promise.resolve(handler(url, init))
        if (url.pathname.endsWith('/files/image')) {
            return Promise.resolve(new Response(new Uint8Array(png()).buffer, { headers: { 'content-type': 'image/png' } }))
        }
        if (url.pathname.endsWith('/files/pdf')) return Promise.resolve(page(url))
        return Promise.resolve(Response.json({ error: 'unexpected' }, { status: 404 }))
    }))
}

async function render(agentId: string | undefined, files: FileCardEntry[]) {
    if (!root) root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root!.render(<DesktopFileCard agentId={agentId} card={{ kind: 'file', files }} />) })
}

async function click(name: string) {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}

beforeEach(() => {
    calls.length = 0
    let next = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pdf-${++next}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

test('PDF cards use document glyphs, fetch only the opened page, and keep attachment arrows separate', async () => {
    installFetch()
    await render('agent 1', [pdf('alpha.pdf', '8:1'), pdf('beta.pdf', '8:2')])
    expect(calls).toHaveLength(0)
    expect(document.querySelector('.grid-cols-2')).toBeNull()
    expect(document.querySelector('[data-file-card] img')).toBeNull()
    expect(button('Open alpha.pdf')).toBeDefined()
    expect(button('Open beta.pdf')).toBeDefined()

    await click('Open alpha.pdf')
    expect(frame()?.alt).toBe('alpha.pdf, page 1 of 2')
    expect(dialog()?.querySelector('iframe, object, embed, audio, video')).toBeNull()
    expect(dialog()?.querySelector('a[download]')).toBeNull()
    expect(dialog()?.textContent).toContain('1 / 2')
    expect(button('Previous attachment')).toBeDefined()
    expect(button('Previous page')).toBeDefined()
    expect(button('Back')).toBeUndefined()
    expect(button('Previous file')).toBeUndefined()
    const opened = calls.at(-1)!
    expect(opened.url.pathname).toBe('/api/desktop/agents/agent%201/files/pdf')
    expect(opened.url.searchParams.get('path')).toBe('reports/alpha.pdf')
    expect(opened.url.searchParams.get('identity')).toBe('8:1')
    expect(opened.url.searchParams.get('page')).toBe('1')
    expect(opened.url.searchParams.get('scale')).toBe('1')
    expect(calls.some(call => call.url.pathname.includes('/files/read'))).toBe(false)

    await click('Next page')
    expect(dialog()?.textContent).toContain('1 / 2')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('alpha.pdf')
    expect(calls.at(-1)?.url.searchParams.get('page')).toBe('2')
    expect(frame()?.alt).toBe('alpha.pdf, page 2 of 2')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pdf-1')

    await click('Next attachment')
    expect(dialog()?.textContent).toContain('2 / 2')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('beta.pdf')
    expect(calls.at(-1)?.url.searchParams.get('path')).toBe('reports/beta.pdf')
    expect(calls.at(-1)?.url.searchParams.get('page')).toBe('1')
    expect(calls.filter(call => call.url.pathname.endsWith('/files/pdf'))).toHaveLength(3)
    expect(opened.signal?.aborted).toBe(true)
    expect(frame()?.alt).toBe('beta.pdf, page 1 of 2')
})

test('closing a PDF releases the pending page and ignores its late bytes', async () => {
    const pending = deferred<Response>()
    installFetch(() => pending.promise)
    await render('agent-1', [pdf('alpha.pdf', '8:1')])
    await click('Open alpha.pdf')
    expect(frame()).toBeNull()
    expect(calls).toHaveLength(1)
    await click('Close')
    expect(dialog()).toBeNull()
    expect(calls[0]?.signal?.aborted).toBe(true)
    await act(async () => { pending.resolve(page(calls[0]!.url)) })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(frame()).toBeNull()
})

test('a mixed card keeps the PDF out of the album and does not fetch it until it is opened', async () => {
    installFetch()
    await render('agent-1', [image(), pdf('deck.pdf', '4:1')])
    expect(document.querySelector('.grid-cols-2')).toBeNull()
    expect(calls.map(call => call.url.pathname)).toEqual(['/api/desktop/agents/agent-1/files/image'])
    const thumbnail = button('Open photo.png')?.querySelector('img')
    expect(thumbnail?.getAttribute('alt')).toBe('photo.png')
    const thumbnailUrl = thumbnail?.getAttribute('src')
    await click('Open deck.pdf')
    expect(calls.at(-1)?.url.pathname).toBe('/api/desktop/agents/agent-1/files/pdf')
    expect(calls.at(-1)?.url.searchParams.get('path')).toBe('reports/deck.pdf')
    expect(frame()).not.toBeNull()
    // Opening a lightbox releases the card thumbnails so only its preview stays live.
    expect(button('Open photo.png')?.querySelector('img')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(thumbnailUrl)
    await click('Close')
    expect(calls.at(-1)?.url.pathname).toBe('/api/desktop/agents/agent-1/files/image')
    expect(button('Open photo.png')?.querySelector('img')?.getAttribute('alt')).toBe('photo.png')
})

test('a replaced PDF shows the route error, and a missing identity is not fetched', async () => {
    installFetch(url => url.pathname.endsWith('/files/pdf')
        ? Response.json({ error: '“alpha.pdf” was renamed or replaced. It was left unchanged.' }, { status: 409 })
        : page(url))
    await render('agent-1', [pdf('alpha.pdf', '8:1')])
    await click('Open alpha.pdf')
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('“alpha.pdf” was renamed or replaced. It was left unchanged.')
    expect(frame()).toBeNull()
    expect(button('Retry')).toBeDefined()
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    await act(async () => { root?.unmount() })
    root = undefined
    document.body.innerHTML = ''
    calls.length = 0
    await render('agent-1', [{ path: 'reports/plain.pdf', name: 'plain.pdf', size: 20, scope: 'agent' }])
    await click('Open plain.pdf')
    expect(dialog()?.textContent).toContain('Send this PDF to preview again.')
    expect(calls).toHaveLength(0)
})

test('changing the conversation owner closes the old page and opens the new owner only after a click', async () => {
    installFetch()
    await render('alice', [pdf('alpha.pdf', '8:1')])
    await click('Open alpha.pdf')
    await click('Next page')
    const previous = calls.at(-1)!
    const previousCount = calls.length
    expect(previous.url.searchParams.get('page')).toBe('2')
    await render('bob', [pdf('alpha.pdf', '9:9')])
    expect(previous.signal?.aborted).toBe(true)
    expect(dialog()).toBeNull()
    expect(frame()).toBeNull()
    expect(calls).toHaveLength(previousCount)
    await click('Open alpha.pdf')
    expect(calls.at(-1)?.url.pathname).toBe('/api/desktop/agents/bob/files/pdf')
    expect(calls.at(-1)?.url.searchParams.get('identity')).toBe('9:9')
    expect(calls.at(-1)?.url.searchParams.get('page')).toBe('1')
    expect(frame()?.alt).toBe('alpha.pdf, page 1 of 2')
})
