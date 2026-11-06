import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createDesktopDocumentAttachmentService } from './service'
import { desktopDocumentStore, ensureDesktopDocumentAttachmentsSchema } from './store'
import { desktopDocumentBlobs } from './storage'
import { desktopDocumentAttachmentsApi } from './api'
import { uploadDesktopDocument, listDesktopDocuments, convertDesktopDocument } from '../../document-attachments/client'
import { DesktopHttpError } from '../auth'
import type { DesktopDocumentScope } from '@rerun/contracts'

const scope = { agentId: 'owner', tabUid: 'tab', sessionId: 'session' }
const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllGlobals(); for (const close of cleanup.splice(0)) await close() })
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'rerun-documents-')), url = `file:${join(directory, 'documents.db')}`
    let db: Client = createClient({ url })
    cleanup.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
    await db.executeMultiple("PRAGMA foreign_keys=ON; CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner'); INSERT INTO desktop_agents VALUES('other');")
    await ensureDesktopDocumentAttachmentsSchema(db)
    let available = true
    const owner = vi.fn(async (value: DesktopDocumentScope, signal: AbortSignal) => { signal.throwIfAborted(); if (!available || value.agentId !== scope.agentId || value.tabUid !== scope.tabUid || value.sessionId !== scope.sessionId) throw new Error('owner changed') })
    const extract = vi.fn(async () => 'Actual PDF text'), transcribe = vi.fn(async () => 'Actual audio text'), references = vi.fn(async () => false)
    const serviceOf = () => createDesktopDocumentAttachmentService({ store: desktopDocumentStore(db), blobs: desktopDocumentBlobs(db), owner, references, extractPdfText: extract, transcribeAudio: transcribe, transcriptionAvailable: async () => true })
    let service = serviceOf()
    const signal = new AbortController().signal
    const upload = (position = 0, id: string = randomUUID()) => service.upload(scope, { ...scope, attachmentId: id, name: `${position}.pdf`, mimeType: 'application/pdf', position }, pdf, signal)
    const ready = async (position = 0) => { const a = await upload(position); return service.convert(scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, signal) }
    return { get db() { return db }, get service() { return service }, owner, extract, transcribe, references, signal, upload, ready, revoke: () => { available = false }, restart: () => { db.close(); db = createClient({ url }); service = serviceOf() } }
}
it('real SQLite upload replay works at capacity and selected order and immutable bytes survive reopen', async () => {
    const f = await fixture(), first = await f.upload(9)
    for (let position = 8; position >= 0; position--) await f.upload(position)
    f.restart()
    const replay = await f.upload(9, first.attachmentId)
    expect(replay.sha256).toBe(first.sha256)
    expect(replay.revision).toBe(first.revision)
    expect((await f.service.list(scope, f.signal)).map(a => a.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect((await f.service.read(scope, first.attachmentId, first.sha256, f.signal)).bytes).toEqual(pdf)
    await expect(f.upload(10)).rejects.toThrow('ten files')
    await expect(f.service.read({ ...scope, sessionId: 'foreign' }, first.attachmentId, first.sha256, f.signal)).rejects.toThrow()
})
it('capacity is reserved atomically for concurrent uploads', async () => {
    const f = await fixture()
    for (let position = 0; position < 9; position++) await f.upload(position)
    const results = await Promise.allSettled([f.upload(9), f.upload(10)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await f.service.list(scope, f.signal)).toHaveLength(10)
})
it('admission freezes only its ordered selection and model; consume clears selection without deleting history bytes', async () => {
    const f = await fixture(), a = await f.ready(0), b = await f.ready(1)
    const selection = { admissionId: randomUUID(), attachmentIds: [b.attachmentId, a.attachmentId], modelChoice: { connectionId: 'codex', model: 'terra' } }
    const result = await f.service.admission(scope, selection, f.signal)
    expect(result.references.map(item => item.attachmentId)).toEqual(selection.attachmentIds)
    await f.service.consume(scope, selection.admissionId, f.signal)
    f.restart()
    expect(await f.service.list(scope, f.signal)).toEqual([])
    expect(await f.service.admission(scope, selection, f.signal)).toEqual(result)
    expect((await f.service.read(scope, a.attachmentId, a.sha256, f.signal)).bytes).toEqual(pdf)
    await expect(f.service.admission(scope, { ...selection, modelChoice: { connectionId: 'codex', model: 'sol' } }, f.signal)).rejects.toThrow('changed')
    await expect(f.service.admission(scope, { ...selection, admissionId: randomUUID() }, f.signal)).rejects.toThrow('changed')
    await expect(f.service.admission(scope, { admissionId: randomUUID(), attachmentIds: [randomUUID()] }, f.signal)).rejects.toThrow()
})
it('an admission racing a paused discard protects the exact bytes', async () => {
    const f = await fixture(), a = await f.ready()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    f.references.mockImplementation(async () => { entered(); await gate; return false })
    const discard = f.service.discard(scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, f.signal)
    await waiting
    const admission = await f.service.admission(scope, { admissionId: randomUUID(), attachmentIds: [a.attachmentId] }, f.signal)
    release()
    await expect(discard).rejects.toThrow('changed')
    expect(admission.allowed).toBe(true)
    expect((await f.service.read(scope, a.attachmentId, a.sha256, f.signal)).bytes).toEqual(pdf)
})
it.each(['revoke', 'stop'] as const)('does not publish helper output after %s and never restarts conversion on restore', async mode => {
    const f = await fixture(), a = await f.upload()
    const controller = new AbortController(); let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    f.extract.mockImplementation(async () => { entered(); await gate; return 'must not publish' })
    const work = f.service.convert(scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, controller.signal)
    await waiting
    if (mode === 'revoke') f.revoke(); else controller.abort()
    release(); await expect(work).rejects.toThrow()
    expect((await desktopDocumentStore(f.db).read(scope, a.attachmentId))?.attachment.conversion.state).toBe('converting')
    f.restart()
    if (mode === 'stop') expect((await f.service.list(scope, f.signal))[0]?.conversion.state).toBe('failed')
    expect(f.extract).toHaveBeenCalledTimes(1)
})
it('discard tombstones defeat late replay and conversion remains an explicit user operation', async () => {
    const f = await fixture(), a = await f.upload()
    expect(f.extract).not.toHaveBeenCalled(); expect(f.transcribe).not.toHaveBeenCalled()
    await f.service.discard(scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, f.signal)
    f.restart()
    await expect(f.upload(0, a.attachmentId)).rejects.toThrow('changed')
    expect(await f.service.list(scope, f.signal)).toEqual([])
})
it('cancels an unacknowledged upload before reservation and defeats delayed upload after restart', async () => {
    const f = await fixture(), id = randomUUID()
    await f.service.cancelUpload(scope, id, f.signal)
    f.restart()
    await expect(f.upload(0, id)).rejects.toThrow('changed')
    expect((await f.db.execute('SELECT COUNT(*) AS count FROM desktop_document_blobs')).rows[0]?.count).toBe(0)
})
it('refuses oversized converted input without silently truncating or admitting it', async () => {
    const f = await fixture(), a = await f.upload()
    f.extract.mockResolvedValue('x'.repeat(128 * 1024 + 1))
    const ready = await f.service.convert(scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, f.signal)
    const admission = await f.service.admission(scope, { admissionId: randomUUID(), attachmentIds: [a.attachmentId] }, f.signal)
    expect(ready.conversion.text?.length).toBe(128 * 1024 + 1)
    expect(admission).toMatchObject({ allowed: false, references: [], inputs: [] })
    expect((await desktopDocumentStore(f.db).read(scope, a.attachmentId))?.attachment.admitted).toBe(false)
})
it('real API and client preserve strict upload/convert/list envelopes and reject foreign envelope owners', async () => {
    const f = await fixture(), api = desktopDocumentAttachmentsApi(f.service)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        try { return await api(new Request(`http://127.0.0.1:3000${url}`, init), scope.agentId) }
        catch (error) { if (error instanceof DesktopHttpError) return Response.json({ error: error.message }, { status: error.status }); throw error }
    }))
    const id = randomUUID(), file = new File([pdf], 'sample.pdf', { type: 'application/pdf' })
    const uploaded = await uploadDesktopDocument(scope, id, file, f.signal)
    expect(uploaded.uploaded).toBe(true)
    expect((await listDesktopDocuments(scope))[0]?.attachmentId).toBe(id)
    const converted = await convertDesktopDocument(scope, id, uploaded.revision, f.signal)
    expect(converted.conversion.text).toBe('Actual PDF text')
    await expect(api(new Request('http://localhost/documents', { method: 'POST', body: JSON.stringify({ operation: 'admission', ...scope, agentId: 'other', admissionId: randomUUID(), attachmentIds: [id] }) }), scope.agentId)).rejects.toThrow('another coworker')
})
