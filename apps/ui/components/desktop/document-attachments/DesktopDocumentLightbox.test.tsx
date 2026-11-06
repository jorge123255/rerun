// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { DesktopDocumentLightbox } from './DesktopDocumentLightbox'
import type { DesktopDocumentAttachment } from '../../../../../packages/contracts/src/desktop-document-attachments.ts'

const scope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'session-1' }
const base = {
    scope,
    byteLength: 12,
    sha256: 'a'.repeat(64),
    admitted: false,
    revision: crypto.randomUUID(),
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
}
const attachments: DesktopDocumentAttachment[] = [
    { ...base, attachmentId: '11111111-1111-4111-8111-111111111111', name: 'report.pdf', mimeType: 'application/pdf', kind: 'pdf', conversion: { mode: 'pdf-text', state: 'ready', text: 'text' } },
    { ...base, attachmentId: '22222222-2222-4222-8222-222222222222', name: 'blob.bin', mimeType: 'application/octet-stream', kind: 'binary', conversion: { mode: 'unsupported', state: 'unsupported' } },
]
const { pdf } = vi.hoisted(() => ({
    pdf: vi.fn(({ name, path, identity, srcUrl }) => <div data-testid="pdf-preview" data-name={name} data-path={path} data-identity={identity} data-url={srcUrl} />),
}))
vi.mock('../DesktopFilePdfPreview', () => ({ DesktopFilePdfPreview: pdf }))
vi.mock('../DesktopFileAudioPreview', () => ({ DesktopFileAudioPreview: () => <div data-testid="audio-preview" /> }))
vi.mock('../DesktopFileVideoPreview', () => ({ DesktopFileVideoPreview: () => <div data-testid="video-preview" /> }))

let root: Root | undefined
beforeAll(() => {
    if (!window.matchMedia) window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia
})
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

it('preserves saved attachment identity, paging and generic downloads without autoplay', async () => {
    const onIndexChange = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const urlsFor = (attachment: DesktopDocumentAttachment) => ({ previewUrl: `/api/desktop/agents/owner/files/pdf?path=${attachment.attachmentId}`, downloadUrl: `/api/desktop/agents/owner/files/download?path=${attachment.attachmentId}` })
    await act(async () => root!.render(<DesktopDocumentLightbox attachments={attachments} index={0} urlsFor={urlsFor} onIndexChange={onIndexChange} onClose={() => {}} />))
    expect(document.querySelector('[data-testid="pdf-preview"]')).toMatchObject({
        dataset: { name: 'report.pdf', path: attachments[0]!.attachmentId, identity: attachments[0]!.sha256, srcUrl: urlsFor(attachments[0]!).previewUrl },
    })
    expect(document.querySelector('[data-testid="audio-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="video-preview"]')).toBeNull()

    await act(async () => {
        const next = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Next attachment')!
        next.click()
    })
    expect(onIndexChange).toHaveBeenCalledWith(1)
    await act(async () => root!.render(<DesktopDocumentLightbox attachments={attachments} index={1} urlsFor={urlsFor} onIndexChange={onIndexChange} onClose={() => {}} />))
    expect(document.querySelector('a[download="blob.bin"]')).not.toBeNull()
})
