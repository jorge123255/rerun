// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopDocumentReference } from '@rerun/contracts'
import { DesktopDocumentLightbox } from './DesktopDocumentLightbox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const pdf = vi.hoisted(() => vi.fn(({ name }: { name: string; source: { loadPage: (page: number, scale: number, signal: AbortSignal) => Promise<Response> } }) => <div data-testid="pdf-page">{name}</div>))
vi.mock('../DesktopFilePdfPreview', () => ({ DesktopFilePdfPreview: pdf }))
const scope = { agentId: 'owner', tabUid: 'tab', sessionId: 'session' }
const first: DesktopDocumentReference = { attachmentId: '11111111-1111-4111-8111-111111111111', scope, name: 'original.pdf', mimeType: 'application/pdf', kind: 'pdf', sha256: 'a'.repeat(64), byteLength: 12 }
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.clearAllMocks() })
it('uses an exact immutable page adapter with original title and paged navigation, without a mutable Files URL', async () => {
    const second = { ...first, attachmentId: '22222222-2222-4222-8222-222222222222', name: 'bundle.zip', kind: 'binary' as const, mimeType: 'application/octet-stream' }
    const next = vi.fn(), fetch = vi.fn().mockResolvedValue(new Response('PNG', { headers: { 'x-rerun-document-sha256': first.sha256 } }))
    vi.stubGlobal('fetch', fetch)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopDocumentLightbox attachments={[first, second]} index={0} onIndexChange={next} onClose={() => {}} />))
    expect(document.body.textContent).toContain('original.pdf'); expect(document.body.textContent).toContain('1 / 2')
    await pdf.mock.calls.at(-1)![0].source.loadPage(2, 1, new AbortController().signal)
    const url = new URL(fetch.mock.calls[0]![0], 'http://127.0.0.1')
    expect(url.pathname).toBe('/api/desktop/coworkers/owner/document-attachments')
    expect(url.searchParams.get('attachmentId')).toBe(first.attachmentId)
    expect(url.searchParams.get('sha256')).toBe(first.sha256)
    expect(url.searchParams.get('page')).toBe('2')
    await act(async () => (document.querySelector('[aria-label="Next attachment"]') as HTMLButtonElement).click())
    expect(next).toHaveBeenCalledWith(1)
    await act(async () => root!.render(<DesktopDocumentLightbox attachments={[first, second]} index={1} onIndexChange={next} onClose={() => {}} />))
    expect(document.body.textContent).toContain('No preview available for this file type')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(document.querySelector('audio[autoplay],video[autoplay]')).toBeNull()
})

it('renders the full text attachment and refuses a later response with mismatched bytes', async () => {
    const text = 'a,b\n' + 'x'.repeat(64 * 1024) + '\n<svg>data</svg>'
    const bytes = new TextEncoder().encode(text)
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
    const csv = { ...first, kind: 'text' as const, mimeType: 'text/plain', name: 'data.csv', byteLength: bytes.length, sha256 }
    const other = { ...csv, attachmentId: '22222222-2222-4222-8222-222222222222', name: 'other.log' }
    const differentBytes = new Uint8Array(bytes)
    differentBytes[0] = 0x5a
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'x-rerun-document-sha256': sha256 }
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(bytes, { headers }))
        .mockResolvedValueOnce(new Response(differentBytes, { headers })))

    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (index: number) => <DesktopDocumentLightbox attachments={[csv, other]} index={index} onIndexChange={() => {}} onClose={() => {}} />
    await act(async () => root!.render(render(0)))
    await vi.waitFor(() => expect(document.querySelector('pre')?.textContent).toBe(text))
    expect(document.querySelector('pre svg')).toBeNull()

    await act(async () => root!.render(render(1)))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('This attachment changed.'))
    expect(document.querySelector('pre')).toBeNull()
})
