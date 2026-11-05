// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopFilePdfPreview } from './DesktopFilePdfPreview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const png = () => Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k7foAAAAASUVORK5CYII='), value => value.charCodeAt(0))
const sourceHash = 'a'.repeat(64)
const upright = { page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: 'Alpha and Alpha', runs: [{ start: 0, end: 5, x: 0.1, y: 0.2, w: 0.2, h: 0.03 }, { start: 10, end: 15, x: 0.4, y: 0.2, w: 0.2, h: 0.03 }] }
const turned = { page: 2, rotation: 90, crop: { x: 36, y: 36, width: 540, height: 720 }, pageWidth: 720, pageHeight: 540, text: 'Alpha two', runs: [{ start: 0, end: 5, x: 0.25, y: 0.3, w: 0.2, h: 0.04 }] }
const props: ComponentProps<typeof DesktopFilePdfPreview> = {
    name: 'report.pdf', path: 'docs/report.pdf', identity: '8:1',
    srcUrl: '/api/desktop/agents/alice/files/pdf?path=docs%2Freport.pdf&identity=8%3A1', onBack: vi.fn(),
}
let root: Root | undefined
const calls: { url: URL; signal: AbortSignal | null | undefined }[] = []
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const image = () => document.querySelector<HTMLImageElement>('[data-testid="file-pdf-preview"]')
const layer = () => document.querySelector<HTMLElement>('[data-testid="file-pdf-text-layer"]')
const count = () => document.querySelector('[data-testid="file-pdf-find-count"]')?.textContent ?? ''
const status = () => document.querySelector('[data-testid="file-pdf-find"] [role="status"]')?.textContent ?? ''
const textCalls = () => calls.filter(call => call.url.pathname.endsWith('/files/pdf-text'))
const pageCalls = () => calls.filter(call => call.url.pathname.endsWith('/files/pdf'))

function pageResponse(page = 1, extra: Record<string, string> = {}, points = true) {
    const sizes = !points ? {} : page === 2
        ? { 'x-pdf-page-width': '720', 'x-pdf-page-height': '540' }
        : { 'x-pdf-page-width': '612', 'x-pdf-page-height': '792' }
    return new Response(png(), { headers: {
        'content-type': 'image/png', 'x-pdf-page': String(page), 'x-pdf-pages': '2', 'x-pdf-width': '1', 'x-pdf-height': '1', 'x-pdf-sha256': sourceHash, ...sizes, ...extra,
    } })
}
function textResponse(body: Record<string, unknown> = { identity: '8:1', path: 'docs/report.pdf', pageCount: 2, truncated: false, reason: '', pages: [upright, turned] }) {
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'x-pdf-sha256': sourceHash } })
}
function deferred<T>() {
    let resolve!: (value: T) => void
    return { promise: new Promise<T>(done => { resolve = done }), resolve }
}
function installFetch(text: () => Response | Promise<Response> = () => textResponse(), points = true) {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push({ url, signal: init?.signal })
        expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
        if (url.pathname.endsWith('/files/pdf-text')) return Promise.resolve(text())
        return Promise.resolve(pageResponse(Number(url.searchParams.get('page')), {}, points))
    }))
}
async function render(overrides: Partial<ComponentProps<typeof DesktopFilePdfPreview>> = {}) {
    if (!root) { const container = document.createElement('div'); document.body.append(container); root = createRoot(container) }
    await act(async () => { root!.render(<DesktopFilePdfPreview {...props} {...overrides} />) })
}
async function click(name: string) {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}
async function typeQuery(value: string) {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find text"]')
    expect(input).not.toBeNull()
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, value)
        input!.dispatchEvent(new Event('input', { bubbles: true }))
        await Promise.resolve()
    })
}

beforeEach(() => {
    calls.length = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:pdf-text')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(async () => {
    await act(async () => { root?.unmount() }); root = undefined
    vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''
})

test('a page response without point size does not fetch or paint text', async () => {
    installFetch(() => textResponse(), false)
    await render()
    expect(image()).not.toBeNull()
    expect(textCalls()).toHaveLength(0)
    expect(document.querySelector('[data-testid="file-pdf-find"]')).toBeNull()
    expect(layer()).toBeNull()
    expect(document.querySelector('iframe, object, embed')).toBeNull()
})

test('aligns a selectable layer to the displayed crop and moves Find to the matching page', async () => {
    installFetch()
    await render()
    expect(textCalls()).toHaveLength(1)
    expect(textCalls()[0]?.url.searchParams.get('path')).toBe('docs/report.pdf')
    expect(textCalls()[0]?.url.searchParams.get('sha256')).toBe(sourceHash)
    expect(textCalls()[0]?.url.searchParams.get('page')).toBeNull()
    expect(textCalls()[0]?.url.searchParams.get('scale')).toBeNull()
    expect(layer()?.dataset.pdfRotation).toBe('0')
    expect(layer()?.dataset.pdfPageWidth).toBe('612')
    expect(layer()?.dataset.pdfCrop).toBe('0,0,612,792')
    expect(layer()?.textContent).toContain('Alpha')
    expect(document.querySelector('iframe, object, embed')).toBeNull()
    await typeQuery('Alpha')
    expect(count()).toBe('1 of 3')
    const mark = document.querySelector<HTMLElement>('[data-pdf-match="active"]')
    expect(mark?.style.left).toBe('10%')
    await click('Next match')
    expect(count()).toBe('2 of 3')
    expect(pageCalls()).toHaveLength(1)
    expect(document.querySelector<HTMLElement>('[data-pdf-match="active"]')?.style.left).toBe('40%')
    await click('Next match')
    expect(pageCalls().map(call => call.url.searchParams.get('page'))).toEqual(['1', '2'])
    expect(textCalls()).toHaveLength(1)
    expect(count()).toBe('3 of 3')
    expect(layer()?.dataset.pdfRotation).toBe('90')
    expect(layer()?.dataset.pdfPageWidth).toBe('720')
    expect(layer()?.dataset.pdfCrop).toBe('36,36,540,720')
    await click('Zoom in')
    expect(textCalls()).toHaveLength(1)
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find text"]')
    await act(async () => { input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })) })
    expect(count()).toBe('2 of 3')
    expect(layer()?.dataset.pdfRotation).toBe('0')
})

test('a newer query replaces the previous match count', async () => {
    installFetch(); await render(); await typeQuery('Alpha')
    expect(count()).toBe('1 of 3')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find text"]')
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, 'Alpha')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
        setter?.call(input, 'zzz')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
        await Promise.resolve()
    })
    expect(count()).not.toBe('1 of 3')
    expect(status()).toBe('No matches')
})

test('a partial match uses part of the run', async () => {
    installFetch(); await render(); await typeQuery('Alp')
    expect(Number.parseFloat(document.querySelector<HTMLElement>('[data-pdf-match="active"]')?.style.width ?? '')).toBeCloseTo(12, 5)
})

test('typing a query jumps directly to its first matching page and rotates its selection layer', async () => {
    installFetch(); await render(); await typeQuery('two')
    expect(count()).toBe('1 of 1')
    expect(pageCalls().map(call => call.url.searchParams.get('page'))).toEqual(['1', '2'])
    const run = layer()?.querySelector<HTMLElement>('[data-pdf-text-start]')
    expect(run?.style.transform).toBe('rotate(90deg)')
})

test('copy across positioned runs preserves the PDF whitespace between them', async () => {
    installFetch(); await render()
    const spans = layer()!.querySelectorAll('[data-pdf-text-start] > span')
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(spans[0]!.firstChild!, 0)
    range.setEnd(spans[1]!.firstChild!, 5)
    selection.removeAllRanges(); selection.addRange(range)
    const clipboard = { setData: vi.fn() }
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: clipboard })
    await act(async () => { spans[0]!.dispatchEvent(event) })
    expect(clipboard.setData).toHaveBeenCalledWith('text/plain', 'Alpha and Alpha')
    expect(event.defaultPrevented).toBe(true)
    selection.removeAllRanges()
})

test('a new raster hash drops the old text and refuses an extract of different bytes', async () => {
    let rasterHash = sourceHash
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push({ url, signal: init?.signal })
        if (url.pathname.endsWith('/files/pdf-text')) return Promise.resolve(textResponse())
        return Promise.resolve(pageResponse(1, { 'x-pdf-sha256': rasterHash }))
    }))
    await render()
    expect(layer()).not.toBeNull()
    rasterHash = 'b'.repeat(64)
    await click('Zoom in')
    expect(textCalls()).toHaveLength(2)
    expect(textCalls()[1]?.url.searchParams.get('sha256')).toBe(rasterHash)
    expect(layer()).toBeNull()
    expect(status()).toBe('This PDF changed. Reopen it to search the current document.')
})

test('a scanned page says there is no searchable text, including while a query is typed', async () => {
    const scanned = { page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: '', runs: [] }
    installFetch(() => textResponse({ identity: '8:1', path: 'docs/report.pdf', pageCount: 1, truncated: false, reason: '', pages: [scanned] }))
    await render()
    expect(status()).toBe('No searchable text')
    expect(layer()).toBeNull()
    await typeQuery('Alpha')
    expect(status()).toBe('No searchable text')
    expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('a truncated page with no words does not claim the PDF has no text', async () => {
    const blank = { page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: '   ', runs: [] }
    installFetch(() => textResponse({ identity: '8:1', path: 'docs/report.pdf', pageCount: 4, truncated: true, reason: 'text', pages: [blank] }))
    await render()
    expect(status()).toBe('Search covers only part of this PDF.')
    expect(status()).not.toBe('No searchable text')
})

test('text that does not match the displayed page is not painted', async () => {
    installFetch(() => textResponse(), true)
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push({ url, signal: init?.signal })
        if (url.pathname.endsWith('/files/pdf-text')) return Promise.resolve(textResponse())
        return Promise.resolve(pageResponse(1, { 'x-pdf-page-width': '100', 'x-pdf-page-height': '200' }))
    }))
    await render()
    expect(image()).not.toBeNull()
    expect(layer()).toBeNull()
    expect(status()).toBe('This page’s text does not match the displayed page.')
})

test('a changed file identity and a text error stay off the page alert', async () => {
    installFetch(() => textResponse({ identity: '1:1', path: 'docs/report.pdf', pageCount: 2, truncated: false, reason: '', pages: [upright, turned] }))
    await render()
    expect(layer()).toBeNull()
    expect(status()).toBe('Send this PDF to preview again.')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { root?.unmount() }); root = undefined
    installFetch(() => new Response(JSON.stringify({ error: 'Could not read this PDF’s text. The file may be damaged, encrypted, or have no supported text.' }), { status: 422, headers: { 'content-type': 'application/json' } }))
    await render()
    expect(image()).not.toBeNull()
    expect(layer()).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(status()).toBe('Could not read this PDF’s text. The file may be damaged, encrypted, or have no supported text.')
})

test('closing the preview aborts text extraction and drops a late payload', async () => {
    const pending = deferred<Response>()
    installFetch(() => pending.promise)
    await render()
    expect(textCalls()).toHaveLength(1)
    await act(async () => { root?.unmount() }); root = undefined
    expect(textCalls()[0]?.signal?.aborted).toBe(true)
    await act(async () => { pending.resolve(textResponse()) })
    expect(layer()).toBeNull()
})

test('a decimal point size still aligns the layer', async () => {
    const wide = { ...upright, crop: { x: 0, y: 0, width: 612.5, height: 792 }, pageWidth: 612.5 }
    installFetch(() => textResponse({ identity: '8:1', path: 'docs/report.pdf', pageCount: 1, truncated: false, reason: '', pages: [wide] }))
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push({ url, signal: init?.signal })
        if (url.pathname.endsWith('/files/pdf-text')) return Promise.resolve(textResponse({ identity: '8:1', path: 'docs/report.pdf', pageCount: 1, truncated: false, reason: '', pages: [wide] }))
        return Promise.resolve(pageResponse(1, { 'x-pdf-page-width': '612.5', 'x-pdf-page-height': '792' }))
    }))
    await render()
    expect(layer()?.dataset.pdfPageWidth).toBe('612.5')
    expect(document.querySelector('[role="alert"]')).toBeNull()
})
