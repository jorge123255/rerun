// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopDocumentAttachment, DesktopDocumentScope } from '@rerun/contracts'
import { useDesktopDocumentAttachments } from './useDesktopDocumentAttachments'
import { queueTabWrite } from '@/lib/desktop/tab-writes'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
    transport.uploadDesktopDocument.mockImplementation(async (owner, id, file: File, _signal, position) => { const a = { ...attachment(id, owner, position), name: file.name, byteLength: file.size }; saved.push(a); return a })
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


it('per-file document add keeps eligible siblings and returns typed outcomes without attaching empty/oversized neighbors', async () => {
    await mount()
    let result!: ReturnType<typeof api.add>
    await act(async () => {
        result = api.add([
            new File(['ok'], 'ok.pdf'),
            new File([], 'empty.pdf'),
            new File(['also'], 'also.pdf'),
        ])
    })
    expect(result.attachedIds).toHaveLength(2)
    expect(result.outcomes.map(row => [row.status, row.name])).toEqual([
        ['attached', 'ok.pdf'],
        ['rejected', 'empty.pdf'],
        ['attached', 'also.pdf'],
    ])
    expect(result.error).toMatch(/empty\.pdf is empty/)
    expect(result.error).not.toMatch(/Nothing was attached/)
    expect(api.attachments.map(a => a.name)).toEqual(['ok.pdf', 'also.pdf'])
    expect(transport.uploadDesktopDocument).toHaveBeenCalledTimes(2)
})

it('a large file saved to Files is accepted, shows its upload progress, and a too-large one is refused with its limit', async () => {
    const MB = 1024 * 1024, coworker = { agentId: 'owner', tabUid: 'tab' }
    const sized = (name: string, size: number) => { const file = new File([], name); Object.defineProperty(file, 'size', { value: size }); return file }
    let report!: (fraction: number) => void, finish!: (value: DesktopDocumentAttachment) => void
    transport.uploadDesktopDocument.mockImplementation((_owner, _id, _file, _signal, _position, onProgress) => new Promise(done => { report = onProgress; finish = done }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe value={coworker} />))
    let added!: ReturnType<typeof api.add>
    await act(async () => { added = api.add([sized('backup.zip', 90 * MB), sized('huge.zip', 101 * MB), sized('scan.pdf', 17 * MB)]) })
    expect(added.outcomes.map(row => row.status)).toEqual(['attached', 'rejected', 'rejected'])
    expect(api.error).toContain('huge.zip is 101 MB. Files saved to this coworker’s Files can be up to 100 MB.')
    expect(api.error).toContain('scan.pdf is 17 MB. This kind of file can be up to 16 MB')
    const id = added.attachedIds[0]!
    expect(api.progress).toEqual({})
    await act(async () => { report(0.314) })
    expect(api.progress).toEqual({ [id]: 0.31 })
    await act(async () => { report(0.999) })
    expect(api.progress).toEqual({ [id]: 0.99 })
    const row = { ...attachment(id, coworker), name: 'backup.zip', kind: 'binary' as const, byteLength: 90 * MB, conversion: { mode: 'staged-file' as const, state: 'ready' as const, stagedRef: 'chat-uploads/x-backup.zip' } }
    await act(async () => { saved.push(row); finish(row) })
    expect(api.progress).toEqual({})
    expect(api.attachments).toMatchObject([{ attachmentId: id, uploaded: true, byteLength: 90 * MB }])
    // The second large file must fit the 200 MB that large files share.
    await act(async () => { added = api.add([sized('second.zip', 100 * MB), sized('third.zip', 20 * MB)]) })
    expect(added.outcomes.map(row => row.status)).toEqual(['attached', 'rejected'])
    expect(api.error).toContain('200 MB in total')
})
