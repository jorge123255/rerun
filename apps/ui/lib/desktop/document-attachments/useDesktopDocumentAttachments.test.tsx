// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopDocumentAttachment, DesktopDocumentScope } from '@rerun/contracts'
import { useDesktopDocumentAttachments } from './useDesktopDocumentAttachments'
import { queueTabWrite } from '@/lib/desktop/tab-writes'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
const scope = { agentId: 'owner', tabUid: 'tab', sessionId: 'session' }
const transport = vi.hoisted(() => ({ uploadDesktopDocument: vi.fn(), listDesktopDocuments: vi.fn(), convertDesktopDocument: vi.fn(), discardDesktopDocument: vi.fn(), detachDesktopDocument: vi.fn(), admitDesktopDocuments: vi.fn(), consumeDesktopDocuments: vi.fn(), cancelDesktopDocumentUpload: vi.fn() }))
vi.mock('./client', () => transport)
function attachment(id: string, currentScope: DesktopDocumentScope = scope, position = 0): DesktopDocumentAttachment {
    return { attachmentId: id, scope: currentScope, name: 'sample.pdf', kind: 'pdf', mimeType: 'application/pdf', byteLength: 8, sha256: 'a'.repeat(64), conversion: { mode: 'pdf-text', state: 'pending' }, admitted: false, selected: true, uploaded: true, position, revision: crypto.randomUUID(), createdAt: 'now', updatedAt: 'now' }
}
let root: Root | undefined, api: ReturnType<typeof useDesktopDocumentAttachments>
let saved: DesktopDocumentAttachment[]
function Probe({ value = scope }: { value?: DesktopDocumentScope }) { const current = useDesktopDocumentAttachments(value); useLayoutEffect(() => { api = current }); return null }
beforeEach(() => {
    cancelDraftShutdown(); saved = []
    Object.values(transport).forEach(mock => mock.mockReset())
    transport.listDesktopDocuments.mockImplementation(async (owner: DesktopDocumentScope) => saved.filter(a => a.scope.agentId === owner.agentId && a.scope.tabUid === owner.tabUid))
    transport.uploadDesktopDocument.mockImplementation(async (owner, id, _file, _signal, position) => { const a = attachment(id, owner, position); saved.push(a); return a })
    transport.convertDesktopDocument.mockImplementation(async (_owner, id) => { const a = saved.find(a => a.attachmentId === id)!; a.conversion = { mode: 'pdf-text', state: 'ready', text: 'actual content' }; return a })
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; cancelDraftShutdown(); vi.clearAllMocks() })
const mount = async () => { root = createRoot(document.body.appendChild(document.createElement('div'))); await act(async () => root!.render(<Probe />)) }
it('saves immediately without preparing, preserves order, and sends only the explicitly prepared selection', async () => {
    await mount()
    await act(async () => { api.add([new File(['first'], 'first.pdf'), new File(['second'], 'second.pdf')]) })
    expect(api.attachments.map(a => a.position)).toEqual([0, 1]); expect(api.busy).toBe(0)
    expect(transport.convertDesktopDocument).not.toHaveBeenCalled()
    await expect(api.settle()).rejects.toThrow('Prepare')
    for (const a of api.attachments) await act(async () => { await api.prepare(a.attachmentId) })
    transport.admitDesktopDocuments.mockResolvedValue({ allowed: true, references: [], inputs: [] })
    let result: Awaited<ReturnType<typeof api.settle>> = null
    await act(async () => { result = await api.settle({ connectionId: 'codex', model: 'terra' }) })
    expect(result).toMatchObject({ selection: { scope, attachmentIds: api.attachments.map(a => a.attachmentId), modelChoice: { connectionId: 'codex', model: 'terra' } } })
})
it('unmount keeps raw upload under the quit hold, then another chat ignores its late completion', async () => {
    let resolve!: (value: DesktopDocumentAttachment) => void
    transport.uploadDesktopDocument.mockImplementation(() => new Promise(done => { resolve = done }))
    await mount()
    await act(async () => { api.add([new File(['pending'], 'pending.pdf')]) })
    const id = transport.uploadDesktopDocument.mock.calls[0]![1]
    await expect(api.settle()).rejects.toThrow('saving')
    const quit = flushDesktopDrafts(); let finished = false; void quit.then(() => { finished = true })
    await act(async () => root!.render(<Probe value={{ ...scope, tabUid: 'other' }} />))
    expect(finished).toBe(false)
    const row = attachment(id)
    await act(async () => { saved.push(row); resolve(row) })
    expect(await quit).toBe(true); expect(api.attachments).toEqual([])
    cancelDraftShutdown()
    await act(async () => root!.render(<Probe />))
    expect(api.attachments[0]?.attachmentId).toBe(id)
    expect(transport.convertDesktopDocument).not.toHaveBeenCalled()
})
it('a lost upload keeps the same File and UUID for retry and never starts conversion', async () => {
    transport.uploadDesktopDocument.mockRejectedValueOnce(new Error('lost acknowledgement'))
    await mount()
    await act(async () => { api.add([new File(['pending'], 'pending.pdf')]) })
    const id = api.attachments[0]!.attachmentId
    expect(api.attachments[0]?.conversion.state).toBe('failed')
    await act(async () => { await api.retry(id) })
    expect(transport.uploadDesktopDocument.mock.calls.map(call => call[1])).toEqual([id, id])
    expect(api.attachments[0]?.uploaded).toBe(true)
    expect(transport.convertDesktopDocument).not.toHaveBeenCalled()
})
it('restored unfinished conversion is explicit and removing a retained history selection only detaches it', async () => {
    const row = attachment(crypto.randomUUID()); row.admitted = true; row.conversion = { mode: 'pdf-text', state: 'ready', text: 'content' }; saved.push(row)
    transport.detachDesktopDocument.mockImplementation(async () => { saved = [] })
    await mount()
    expect(transport.convertDesktopDocument).not.toHaveBeenCalled()
    await act(async () => { await api.remove(row.attachmentId) })
    expect(transport.detachDesktopDocument).toHaveBeenCalledWith(scope, row.attachmentId, row.revision, expect.any(AbortSignal))
    expect(transport.discardDesktopDocument).not.toHaveBeenCalled(); expect(api.attachments).toEqual([])
})
it('removes a failed raw upload through its exact cancellation receipt without requiring another upload', async () => {
    transport.uploadDesktopDocument.mockRejectedValue(new Error('storage full'))
    transport.cancelDesktopDocumentUpload.mockResolvedValue(undefined)
    await mount()
    await act(async () => { api.add([new File(['pending'], 'pending.pdf')]) })
    const id = api.attachments[0]!.attachmentId
    await act(async () => { await api.remove(id) })
    expect(transport.cancelDesktopDocumentUpload).toHaveBeenCalledWith(scope, id, expect.any(AbortSignal))
    expect(transport.uploadDesktopDocument).toHaveBeenCalledTimes(1)
    expect(api.attachments).toEqual([])
    expect(await flushDesktopDrafts()).toBe(true)
})


it('waits for a newly opened tab to be saved before asking for its attachments', async () => {
    let finish!: () => void
    const held = queueTabWrite(scope.agentId, () => new Promise<void>(resolve => { finish = resolve }))
    await mount()
    try {
        expect(api.loaded).toBe(false)
        expect(transport.listDesktopDocuments).not.toHaveBeenCalled()
    } finally {
        await act(async () => { finish(); await held })
    }
    expect(transport.listDesktopDocuments).toHaveBeenCalledWith(scope)
    expect(api.loaded).toBe(true)
    expect(api.error).toBeNull()
})

it('never reads an old tab after its pending save finishes on a different selected conversation', async () => {
    let finish!: () => void
    const held = queueTabWrite(scope.agentId, () => new Promise<void>(resolve => { finish = resolve }))
    await mount()
    const next = { ...scope, tabUid: 'newer-tab' }
    await act(async () => root!.render(<Probe value={next} />))
    await act(async () => { finish(); await held })
    expect(transport.listDesktopDocuments.mock.calls.map(call => call[0])).toEqual([next])
    expect(api.loaded).toBe(true)
})
