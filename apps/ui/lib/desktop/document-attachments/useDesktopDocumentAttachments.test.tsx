// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useDesktopDocumentAttachments } from './useDesktopDocumentAttachments'
import type { DesktopDocumentAttachment } from '../../../../../packages/contracts/src/desktop-document-attachments.ts'

const scope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'session-1' }
const transport = vi.hoisted(() => ({
    uploadDesktopDocument: vi.fn(),
    convertDesktopDocument: vi.fn(),
    listDesktopDocuments: vi.fn(),
    admitDesktopDocuments: vi.fn(),
    discardDesktopDocument: vi.fn(),
}))
vi.mock('@/lib/desktop/document-attachments/client', () => transport)

function attachment(id: string, name: string, state: 'pending' | 'ready' | 'failed' = 'pending'): DesktopDocumentAttachment {
    const now = new Date().toISOString()
    return {
        attachmentId: id,
        scope,
        name,
        mimeType: 'application/pdf',
        kind: 'pdf',
        byteLength: 12,
        sha256: 'a'.repeat(64),
        conversion: { mode: 'pdf-text', state },
        admitted: false,
        revision: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
    }
}

let root: Root | undefined
let api: ReturnType<typeof useDesktopDocumentAttachments>
function Probe() {
    api = useDesktopDocumentAttachments(scope)
    return null
}

afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.clearAllMocks()
})

it('preserves ordered intake and admission without creating another send authority', async () => {
    transport.listDesktopDocuments.mockResolvedValue([])
    transport.uploadDesktopDocument.mockImplementation(async (_scope, id, file: File) => attachment(id, file.name)
    transport.convertDesktopDocument.mockImplementation(async (_scope, id, _revision) => attachment(id, `${id}.pdf`, 'ready'))
    transport.admitDesktopDocuments.mockResolvedValue({ allowed: true, references: [], inputs: [] })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    const first = new File(['%PDF-1.7'], 'first.pdf', { type: 'application/pdf' })
    const second = new File(['%PDF-1.4'], 'second.pdf', { type: 'application/pdf' })

    await act(async () => { api.add([first, second]) })
    expect(api.attachments.map(item => item.name)).toEqual(['first.pdf', 'second.pdf'])
    expect(transport.uploadDesktopDocument).toHaveBeenCalledTimes(2)
    await act(async () => { await api.settle() })
    expect(transport.admitDesktopDocuments).toHaveBeenCalledWith(scope)
})

it('retries a lost upload with the same identity and does not replay pending conversion on restart', async () => {
    const pending = attachment('11111111-1111-4111-8111-111111111111', 'report.pdf')
    transport.listDesktopDocuments.mockResolvedValue([pending])
    transport.uploadDesktopDocument.mockRejectedValueOnce(new Error('lost acknowledgement')).mockResolvedValue(pending)
    transport.convertDesktopDocument.mockResolvedValue({ ...pending, conversion: { mode: 'pdf-text', state: 'ready', text: 'text' } })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    expect(transport.convertDesktopDocument).not.toHaveBeenCalled()

    await act(async () => { api.retry(pending.attachmentId) })
    expect(transport.uploadDesktopDocument).toHaveBeenCalledTimes(1)
    expect(transport.uploadDesktopDocument.mock.calls[0][1]).toBe(pending.attachmentId)
    expect(transport.convertDesktopDocument).toHaveBeenCalledWith(scope, pending.attachmentId, pending.revision)
})
