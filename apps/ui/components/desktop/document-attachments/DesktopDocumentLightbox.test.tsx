// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopDocumentReference } from '@rerun/contracts'
import { DesktopDocumentLightbox } from './DesktopDocumentLightbox'
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
