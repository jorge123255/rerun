// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopFilePdfPreview, isDesktopPdfName } from './DesktopFilePdfPreview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const png = () => Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k7foAAAAASUVORK5CYII='), value => value.charCodeAt(0))
function pageResponse(page = 1, extra: Record<string, string> = {}, body: BodyInit = png()) {
    return new Response(body, { headers: {
        'content-type': 'image/png', 'x-pdf-page': String(page), 'x-pdf-pages': '3',
        'x-pdf-width': '1', 'x-pdf-height': '1', ...extra,
    } })
}
const props: ComponentProps<typeof DesktopFilePdfPreview> = {
    name: 'report.pdf', path: 'docs/report.pdf', identity: '8:1',
    srcUrl: '/api/desktop/agents/alice/files/pdf?path=docs%2Freport.pdf&identity=8%3A1', onBack: vi.fn(),
}
let root: Root | undefined
let createUrl: ReturnType<typeof vi.spyOn>, revokeUrl: ReturnType<typeof vi.spyOn>
const calls: { url: URL; signal: AbortSignal | null | undefined }[] = []
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const image = () => document.querySelector<HTMLImageElement>('[data-testid="file-pdf-preview"]')
async function click(name: string) {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}
async function render(overrides: Partial<ComponentProps<typeof DesktopFilePdfPreview>> = {}) {
    if (!root) { const container = document.createElement('div'); document.body.append(container); root = createRoot(container) }
    await act(async () => { root!.render(<DesktopFilePdfPreview {...props} {...overrides} />) })
}
function deferred<T>() {
    let resolve!: (value: T) => void
    return { promise: new Promise<T>(done => { resolve = done }), resolve }
}
function installFetch(response: (url: URL, call: number) => Response | Promise<Response> = url => pageResponse(Number(url.searchParams.get('page')))) {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push({ url, signal: init?.signal })
        expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
        return Promise.resolve(response(url, calls.length))
    }))
}
beforeEach(() => {
    calls.length = 0
    let next = 0
    createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pdf-${++next}`)
    revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(async () => {
    await act(async () => { root?.unmount() }); root = undefined
    vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''
})

test('renders only a PNG page in the original white frame, with separate file/page controls and bounded zoom', async () => {
    installFetch()
    const previous = vi.fn(), next = vi.fn()
    await render({ siblings: { index: 1, total: 3, previous, next } })
    expect(image()?.src).toBe('blob:pdf-1')
    expect(image()?.alt).toBe('report.pdf, page 1 of 3')
    expect(image()?.parentElement?.className).toContain('bg-white')
    expect(image()?.parentElement?.style.width).toBe('100%')
    expect(document.querySelector('iframe, object, embed')).toBeNull()
    expect(button('Previous page')?.disabled).toBe(true)
    await click('Next file'); await click('Previous file')
    expect(next).toHaveBeenCalledOnce(); expect(previous).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    await click('Next page')
    expect(calls.at(-1)?.url.searchParams.get('page')).toBe('2')
    expect(calls.at(-1)?.url.searchParams.get('identity')).toBe('8:1')
    expect(revokeUrl).toHaveBeenCalledWith('blob:pdf-1')
    expect(image()?.alt).toBe('report.pdf, page 2 of 3')
    for (let i = 0; i < 4; i++) await click('Zoom in')
    expect(calls.at(-1)?.url.searchParams.get('scale')).toBe('2')
    expect(button('Zoom in')?.disabled).toBe(true)
    expect(image()?.parentElement?.style.width).toBe('200%')
    await click('Fit width')
    expect(calls.at(-1)?.url.searchParams.get('scale')).toBe('1')
    expect(calls.at(-1)?.url.searchParams.get('page')).toBe('2')
    await click('Zoom out'); await click('Zoom out')
    expect(calls.at(-1)?.url.searchParams.get('scale')).toBe('0.5')
    expect(button('Zoom out')?.disabled).toBe(true)
    await click('Previous page')
    expect(calls.at(-1)?.url.searchParams.get('page')).toBe('1')
})

test('a newer zoom request aborts a pending page and ignores its late response without creating another URL', async () => {
    const oldPage = deferred<Response>()
    installFetch((url, call) => call === 2 ? oldPage.promise : pageResponse(Number(url.searchParams.get('page'))))
    await render(); await click('Next page')
    expect(image()).toBeNull()
    expect(revokeUrl).toHaveBeenCalledWith('blob:pdf-1')
    await click('Zoom in')
    expect(calls[1].signal?.aborted).toBe(true)
    expect(image()?.src).toBe('blob:pdf-2')
    await act(async () => { oldPage.resolve(pageResponse(2)) })
    expect(image()?.src).toBe('blob:pdf-2')
    expect(createUrl).toHaveBeenCalledTimes(2)
    expect(revokeUrl.mock.calls.flat()).not.toContain('blob:pdf-2')
})

test('changing owner/path/identity resets page and zoom, and late old-owner or unmounted results stay hidden', async () => {
    const oldOwner = deferred<Response>(), afterClose = deferred<Response>()
    installFetch((url, call) => call === 3 ? oldOwner.promise : call === 5 ? afterClose.promise : pageResponse(Number(url.searchParams.get('page'))))
    await render(); await click('Next page'); await click('Zoom in')
    await render({ name: 'other.pdf', path: 'other.pdf', identity: '9:3', srcUrl: '/api/desktop/agents/bob/files/pdf?path=other.pdf&identity=9%3A3' })
    expect(calls[2].signal?.aborted).toBe(true)
    expect(calls.at(-1)?.url.searchParams.get('page')).toBe('1')
    expect(calls.at(-1)?.url.searchParams.get('scale')).toBe('1')
    expect(image()?.alt).toBe('other.pdf, page 1 of 3')
    const accepted = image()!.src
    await act(async () => { oldOwner.resolve(pageResponse(2)) })
    expect(image()?.src).toBe(accepted)
    expect(createUrl).toHaveBeenCalledTimes(3)
    await render({ identity: '8:2', srcUrl: '/api/desktop/agents/alice/files/pdf?path=docs%2Freport.pdf&identity=8%3A2' })
    expect(revokeUrl.mock.calls.filter(([url]: [string]) => url === accepted)).toHaveLength(1)
    await act(async () => { root!.unmount() }); root = undefined
    expect(calls[4].signal?.aborted).toBe(true)
    await act(async () => { afterClose.resolve(pageResponse()) })
    expect(createUrl).toHaveBeenCalledTimes(3)
    expect(image()).toBeNull()
})

test('a transient server error retries the same page and zoom successfully', async () => {
    installFetch((url, call) => call === 3 ? Response.json({ error: 'PDF preview is busy. Try again.' }, { status: 503 }) : pageResponse(Number(url.searchParams.get('page'))))
    await render(); await click('Next page'); await click('Zoom in')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('PDF preview is busy. Try again.')
    expect(image()).toBeNull()
    await click('Retry')
    expect(calls.at(-1)?.url.href).toBe(calls[2].url.href)
    expect(image()?.alt).toBe('report.pdf, page 2 of 3')
    expect(document.querySelector('[aria-label="PDF zoom"]')?.textContent).toBe('125%')
    expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('an image decode failure releases its own URL once, and a later retry owns a fresh URL', async () => {
    installFetch(); await render()
    await act(async () => { image()!.dispatchEvent(new Event('error')) })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This PDF page could not be displayed.')
    expect(image()).toBeNull()
    expect(revokeUrl.mock.calls.filter(([url]: [string]) => url === 'blob:pdf-1')).toHaveLength(1)
    await click('Retry')
    expect(image()?.src).toBe('blob:pdf-2')
    await act(async () => { root!.unmount() }); root = undefined
    expect(revokeUrl.mock.calls.filter(([url]: [string]) => url === 'blob:pdf-1')).toHaveLength(1)
    expect(revokeUrl.mock.calls.filter(([url]: [string]) => url === 'blob:pdf-2')).toHaveLength(1)
})

test.each([
    ['active PDF bytes', { 'content-type': 'application/pdf' }, png()],
    ['SVG bytes', { 'content-type': 'image/svg+xml' }, png()],
    ['wrong page', { 'x-pdf-page': '2' }, png()],
    ['too many pages', { 'x-pdf-pages': '10001' }, png()],
    ['oversized dimensions', { 'x-pdf-width': '4097' }, png()],
    ['too many pixels', { 'x-pdf-width': '4096', 'x-pdf-height': '4096' }, png()],
    ['mismatched PNG dimensions', { 'x-pdf-width': '2' }, png()],
    ['invalid PNG signature', {}, Uint8Array.from([37, 80, 68, 70])],
] as [string, Record<string, string>, Uint8Array<ArrayBuffer>][])('rejects %s without minting a blob URL', async (_name, headers, bytes) => {
    installFetch(() => pageResponse(1, headers, bytes))
    await render()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(image()).toBeNull()
    expect(createUrl).not.toHaveBeenCalled()
})

test('enforces the actual streamed byte budget even when Content-Length claims a smaller response', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)) }, cancel })
    installFetch(() => pageResponse(1, { 'content-length': '68' }, stream))
    await render()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This PDF page is too large to preview.')
    expect(cancel).toHaveBeenCalledOnce()
    expect(createUrl).not.toHaveBeenCalled()
})

test('rejects mismatched route identity before reading and recognizes only plain PDF file names', async () => {
    installFetch(); await render({ identity: 'changed' })
    expect(calls).toHaveLength(0)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not read this PDF.')
    expect(isDesktopPdfName('Report.PDF')).toBe(true)
    for (const name of ['report.pdf.exe', '../report.pdf', 'folder/report.pdf', 'folder\\report.pdf', '.pdf']) expect(isDesktopPdfName(name)).toBe(false)
})
