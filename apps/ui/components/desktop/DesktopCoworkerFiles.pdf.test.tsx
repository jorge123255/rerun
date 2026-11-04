// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'

vi.mock('@/components/files/FileTextEditor', () => ({
    FileTextEditor: ({ value, onChange, fileName, readOnly }: FileCodeMirrorProps) => <textarea
        aria-label={`Edit ${fileName}`} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />,
}))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k7foAAAAASUVORK5CYII='), value => value.charCodeAt(0))
function pdfPage(page: number) {
    return new Response(png, { headers: { 'content-type': 'image/png', 'x-pdf-page': String(page), 'x-pdf-pages': '2', 'x-pdf-width': '1', 'x-pdf-height': '1' } })
}
let root: Root | undefined
let createUrl: ReturnType<typeof vi.spyOn>, revokeUrl: ReturnType<typeof vi.spyOn>
const calls: { url: URL; signal?: AbortSignal | null }[] = []
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const click = async (name: string) => {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
beforeEach(() => {
    calls.length = 0
    let next = 0
    createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:files-pdf-${++next}`)
    revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(async () => {
    await act(async () => { root?.unmount() }); root = undefined
    vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''
})
function installFetch(pdf: (page: number) => Response | Promise<Response> = pdfPage) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        calls.push({ url, signal: init?.signal })
        if (url.pathname.endsWith('/files/pdf')) return pdf(Number(url.searchParams.get('page')))
        if (url.pathname.endsWith('/files/read')) return Response.json({ path: url.searchParams.get('path'), content: 'Existing notes', size: 14, truncated: false, hash: 'abc' })
        if (url.searchParams.get('path') === 'docs') return Response.json({ path: 'docs', entries: [
            { name: 'notes.md', type: 'file', size: 14, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '4:8' },
            { name: 'report.pdf', type: 'file', size: 2048, modifiedAt: '2026-11-04T00:00:00.000Z', identity: '9:1' },
        ] })
        return Response.json({ path: '', entries: [{ name: 'docs', type: 'dir', size: 0, modifiedAt: '2026-11-04T00:00:00.000Z' }] })
    }))
}
async function openPdf() {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => { root!.render(<DesktopCoworkerFiles agent={coworker} />) })
    await click('Files'); await flush(); await click('docs'); await flush(); await click('report.pdf'); await flush()
}

test('Files opens an existing PDF as a PNG page and retains separate file siblings and back navigation', async () => {
    installFetch(); await openPdf()
    const call = calls.find(({ url }) => url.pathname.endsWith('/files/pdf'))!
    expect(call.url.pathname).toBe('/api/desktop/agents/alice/files/pdf')
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ path: 'docs/report.pdf', identity: '9:1', page: '1', scale: '1' })
    expect(document.querySelector('[data-testid="file-pdf-preview"]')?.getAttribute('src')).toBe('blob:files-pdf-1')
    expect(document.querySelector('iframe, object, embed')).toBeNull()
    expect(button('Edit')).toBeUndefined()
    expect(button('Download')).toBeUndefined()
    expect(calls.some(({ url }) => /\/files\/(read|image|audio|video)$/.test(url.pathname))).toBe(false)
    await click('Next page')
    expect(document.querySelector('[data-testid="file-pdf-preview"]')?.getAttribute('alt')).toBe('report.pdf, page 2 of 2')
    expect(button('Next page')?.disabled).toBe(true)
    await click('Previous file'); await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('Existing notes')
    expect(revokeUrl).toHaveBeenCalledWith('blob:files-pdf-2')
    await click('Next file'); await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')?.getAttribute('alt')).toBe('report.pdf, page 1 of 2')
    await click('Back'); await flush()
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    expect(button('report.pdf')).toBeDefined()
    expect(revokeUrl).toHaveBeenCalledWith('blob:files-pdf-3')
})

test('switching coworkers closes a pending PDF and its late response cannot restore a preview', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>(done => { resolve = done })
    installFetch(() => pending); await openPdf()
    const call = calls.find(({ url }) => url.pathname.endsWith('/files/pdf'))!
    expect(document.querySelector('[aria-label="Loading PDF page"]')).not.toBeNull()
    await act(async () => { root!.render(<DesktopCoworkerFiles agent={{ ...coworker, id: 'bob', name: 'Bob' }} />) })
    expect(call.signal?.aborted).toBe(true)
    await act(async () => { resolve(pdfPage(1)) })
    expect(document.querySelector('[data-testid="file-pdf-preview"]')).toBeNull()
    expect(document.querySelector('[aria-label="Loading PDF page"]')).toBeNull()
    expect(createUrl).not.toHaveBeenCalled()
})
