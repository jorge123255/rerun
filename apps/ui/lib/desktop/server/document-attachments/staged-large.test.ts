import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER, desktopStagedDocumentPath, foremanDocumentScope, type DesktopDocumentScope } from '@rerun/contracts'
vi.mock('server-only', () => ({}))
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { createDesktopAgent } from '../store'
import { DESKTOP_FOREMAN_CHAT_SCHEMA, ensureForemanChat } from '../foreman/chat-store'
import { desktopDocumentStagedUploadApi } from './api'
import { createDesktopDocumentRuntime } from './runtime'
import { desktopDocumentStore } from './store'

// Real database, real Files code, a real folder and a real body stream. A file above the document
// limit must end up only as the file in the coworker's Files.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const MB = 1024 * 1024, LARGE = DESKTOP_DOCUMENT_MAX_BYTES + MB
const piece = (index: number) => { const part = new Uint8Array(MB); part.fill(index % 251); part.set([0x50, 0x4b, 3, 4], 0); return part }
/** A body that makes each megabyte only when it is asked for, and counts how many were taken. */
function body(megabytes: number, tail?: Uint8Array) {
    const state = { pulled: 0, cancelled: false }
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (state.pulled < megabytes) controller.enqueue(piece(state.pulled++))
            else { if (tail) controller.enqueue(tail); controller.close() }
        },
        cancel() { state.cancelled = true },
    }, { highWaterMark: 0 })
    return { stream, state }
}
const digestOf = (megabytes: number, tail?: Uint8Array) => { const hash = createHash('sha256'); for (let i = 0; i < megabytes; i++) hash.update(piece(i)); if (tail) hash.update(tail); return hash.digest('hex') }
const fileDigest = async (path: string) => { const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part as Buffer); return hash.digest('hex') }
const spools = async () => (await readdir(tmpdir())).filter(name => name.startsWith('rerun-attachment-'))
const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out }
const box = (type: string, payload: Buffer) => Buffer.concat([u32(payload.length + 8), Buffer.from(type), payload])

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-staged-large-'))
    const db = await openDesktopDatabase(root)
    cleanup.push(async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) })
    const agent = await createDesktopAgent(db, { engineAgentId: 'engine-a', name: 'Files owner' })
    const other = await createDesktopAgent(db, { engineAgentId: 'engine-b', name: 'Sibling' })
    const scope: DesktopDocumentScope = { agentId: agent.id, tabUid: 'tab' }
    for (const id of [agent.id, other.id]) await db.execute({ sql: 'INSERT OR REPLACE INTO desktop_agent_tabs(agent_id,revision,layout) VALUES(?,1,?)', args: [id, JSON.stringify({ tabs: [{ uid: 'tab', id: null }], activeIndex: 0 })] })
    const runtime: DesktopRuntime = { protocolVersion: 1, launchNonce: 'launch', buildId: 'build', workspaceId: 1, dataRoot: root, app: { origin: 'http://127.0.0.1:1111', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:2222', apiKey: 'fixture' } }
    let enabled = true
    const service = await createDesktopDocumentRuntime(runtime, db, { isCurrent: () => true, agent: async id => ({ id, enabled }) })
    const signal = new AbortController().signal
    const workspace = (engineId = 'engine-a') => join(root, 'workspaces', '1', 'engine', 'agents', engineId, 'workspace')
    const files = (engineId?: string) => readdir(join(workspace(engineId), 'chat-uploads')).catch(() => [] as string[])
    const input = (name: string, byteLength: number, id: string = randomUUID(), target = scope) => ({ ...target, attachmentId: id, name, mimeType: 'application/octet-stream', position: 0, byteLength })
    const before = await spools()
    return { root, db, runtime, service, scope, other, signal, workspace, files, input, disable: () => { enabled = false }, leftSpools: async () => (await spools()).filter(name => !before.includes(name)) }
}

it('streams a file above the document limit into the coworker’s Files and nowhere else', async () => {
    const f = await fixture(), megabytes = LARGE / MB, source = body(megabytes), id = randomUUID()
    const saved = await f.service.uploadStaged(f.scope, f.input('backup.zip', LARGE, id), source.stream, f.signal)
    const path = desktopStagedDocumentPath(id, 'backup.zip')
    expect(saved).toMatchObject({ kind: 'binary', byteLength: LARGE, sha256: digestOf(megabytes), uploaded: true, conversion: { mode: 'staged-file', state: 'ready', stagedRef: path } })
    expect((await stat(join(f.workspace(), path))).size).toBe(LARGE)
    expect(await fileDigest(join(f.workspace(), path))).toBe(saved.sha256)
    // No temporary file is left in Files or in the upload folder, and no copy is in the database.
    expect(await f.files()).toEqual([path.slice('chat-uploads/'.length)])
    expect(await f.leftSpools()).toEqual([])
    expect((await f.db.execute('SELECT COUNT(*) AS count FROM desktop_document_blobs')).rows[0]?.count).toBe(0)
    expect(await f.files('engine-b')).toEqual([])
    // It is listed and sent by path like a small staged file; its bytes are not served from here.
    expect(await f.service.list(f.scope, f.signal)).toMatchObject([{ attachmentId: id, conversion: { state: 'ready' } }])
    const selection = { admissionId: randomUUID(), attachmentIds: [id] }
    expect(await f.service.admission(f.scope, selection, f.signal)).toMatchObject({ allowed: true, inputs: [{ mode: 'staged-file', path, reference: { name: 'backup.zip', byteLength: LARGE, sha256: saved.sha256 } }] })
    await expect(f.service.read(f.scope, id, saved.sha256, f.signal)).rejects.toThrow('kept only in this coworker’s Files')
    // The same attempt again changes nothing; a different file under the same attempt is refused.
    expect(await f.service.uploadStaged(f.scope, f.input('backup.zip', LARGE, id), body(megabytes).stream, f.signal)).toMatchObject({ revision: saved.revision })
    await expect(f.service.uploadStaged(f.scope, f.input('backup.zip', LARGE + 1, id), body(megabytes, Uint8Array.of(9)).stream, f.signal)).rejects.toThrow('changed')
    expect(await f.files()).toHaveLength(1)
    expect(await f.leftSpools()).toEqual([])
}, 60_000)

it('an edited copy blocks the send, and removing an unsent large file removes exactly its own copy', async () => {
    const f = await fixture(), megabytes = LARGE / MB
    const a = await f.service.uploadStaged(f.scope, f.input('a.zip', LARGE), body(megabytes).stream, f.signal)
    const b = await f.service.uploadStaged(f.scope, f.input('b.pptx', LARGE), body(megabytes).stream, f.signal)
    await f.service.discard(f.scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, f.signal)
    expect(await f.files()).toEqual([b.conversion.stagedRef!.slice('chat-uploads/'.length)])
    await writeFile(join(f.workspace(), b.conversion.stagedRef!), 'edited by the coworker')
    expect(await f.service.admission(f.scope, { admissionId: randomUUID(), attachmentIds: [b.attachmentId] }, f.signal)).toMatchObject({ allowed: false, inputs: [] })
    await f.service.discard(f.scope, { attachmentId: b.attachmentId, expectedRevision: b.revision }, f.signal)
    expect(await f.files()).toHaveLength(1)
    expect(await f.service.list(f.scope, f.signal)).toEqual([])
}, 60_000)

it('refuses by declared size, kind, place and room before reading a byte', async () => {
    const f = await fixture()
    const untouched = async (name: string, declared: number, message: string, scope = f.scope, service = f.service) => {
        const source = body(declared / MB)
        await expect(service.uploadStaged(scope, f.input(name, declared, randomUUID(), scope), source.stream, f.signal)).rejects.toThrow(message)
        expect(source.state.pulled).toBe(0)
    }
    // Only the kinds saved into Files may pass the document limit; the others keep theirs.
    await untouched('scan.pdf', LARGE, '16 MB')
    await untouched('talk.mp3', LARGE, '16 MB')
    await untouched('notes.txt', LARGE, '16 MB')
    await untouched('photo.png', LARGE, '8 MB')
    await untouched('../escape.zip', LARGE, 'file name')
    await untouched('.hidden.zip', LARGE, 'file name')
    // The schema itself bounds the declared size on both sides.
    for (const declared of [DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_MAX_BYTES + 1]) {
        const source = body(1)
        await expect(f.service.uploadStaged(f.scope, f.input('a.zip', declared), source.stream, f.signal)).rejects.toThrow()
        expect(source.state.pulled).toBe(0)
    }
    await untouched('a.zip', LARGE, 'no longer available', { agentId: f.other.id, tabUid: 'closed' })
    // A question's upload and Chief of Staff have no Files to save into.
    await f.db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA)
    const { chat, sessionId } = await ensureForemanChat(f.db, '1')
    const foreman = foremanDocumentScope(chat, sessionId)
    await untouched('a.zip', LARGE, '16 MB', foreman, await createDesktopDocumentRuntime(f.runtime, f.db, undefined, 'foreman'))
    // Room: ten files, and 200 MB of large files, in one unsent message.
    const row = (id: string, bytes: number) => f.db.execute({ sql: `INSERT INTO desktop_document_attachments(attachment_id,agent_id,tab_uid,fingerprint,name,mime_type,kind,byte_length,sha256,conversion,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, f.scope.agentId, 'tab', 'f', 'held.zip', 'application/zip', 'binary', bytes, 'a'.repeat(64), JSON.stringify({ mode: 'staged-file', state: 'pending' }), randomUUID(), 'now', 'now'] })
    const held = [randomUUID(), randomUUID()]
    await row(held[0]!, 100 * MB); await row(held[1]!, 90 * MB)
    await untouched('more.zip', LARGE, '200 MB in total')
    // A small file is not counted against the large total, nor a large one against the 48 MB.
    const small = await f.service.upload(f.scope, { ...f.scope, attachmentId: randomUUID(), name: 'small.zip', mimeType: 'application/zip', position: 0 }, piece(1).subarray(0, 64), f.signal)
    expect(small.uploaded).toBe(true)
    await f.db.execute({ sql: 'DELETE FROM desktop_document_attachments WHERE attachment_id IN (?,?)', args: held })
    for (let index = 0; index < 9; index++) await row(randomUUID(), 1)
    await untouched('eleventh.zip', LARGE, 'ten files')
    expect(await f.files()).toHaveLength(1)
    expect(await f.leftSpools()).toEqual([])
    f.disable()
    await untouched('a.zip', LARGE, 'no longer available')
}, 60_000)

it('stops a body that runs past, or ends before, its declared size and leaves nothing behind', async () => {
    const f = await fixture(), megabytes = LARGE / MB
    const long = body(megabytes + 40)
    await expect(f.service.uploadStaged(f.scope, f.input('long.zip', LARGE), long.stream, f.signal)).rejects.toThrow('larger than the size it declared')
    // Stopped at the first megabyte past the declared size, not after the rest was received.
    expect(long.state.pulled).toBeLessThanOrEqual(megabytes + 2)
    expect(long.state.cancelled).toBe(true)
    await expect(f.service.uploadStaged(f.scope, f.input('short.zip', LARGE), body(megabytes - 1).stream, f.signal)).rejects.toThrow('ended before the whole file arrived')
    const cancelled = new AbortController(), slow = body(megabytes)
    const pending = f.service.uploadStaged(f.scope, f.input('cancelled.zip', LARGE), slow.stream, cancelled.signal)
    cancelled.abort()
    await expect(pending).rejects.toThrow()
    expect(await f.files()).toEqual([])
    expect(await f.leftSpools()).toEqual([])
    expect(await f.service.list(f.scope, f.signal)).toEqual([])
    expect((await f.db.execute('SELECT COUNT(*) AS count FROM desktop_document_attachments')).rows[0]?.count).toBe(0)
}, 60_000)

it('a large video gets the same structure check as a small one; a file that only claims to be video is refused', async () => {
    const f = await fixture()
    const handler = Buffer.alloc(24); handler.set(Buffer.from('vide'), 8)
    const head = Buffer.concat([box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), Buffer.from('mp42')])), box('moov', box('trak', box('mdia', box('hdlr', handler))))])
    const media = box('mdat', Buffer.alloc(LARGE - head.length - 8, 1))
    const video = Buffer.concat([head, media])
    const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { for (let at = 0; at < bytes.length; at += MB) controller.enqueue(bytes.subarray(at, at + MB)); controller.close() } })
    const saved = await f.service.uploadStaged(f.scope, { ...f.input('clip.mp4', video.length), mimeType: 'video/mp4' }, stream(video), f.signal)
    expect(saved).toMatchObject({ kind: 'video', mimeType: 'video/mp4', byteLength: video.length, conversion: { mode: 'staged-file', state: 'ready' } })
    expect(await fileDigest(join(f.workspace(), saved.conversion.stagedRef!))).toBe(createHash('sha256').update(video).digest('hex'))
    const fake = Buffer.alloc(LARGE, 7)
    await expect(f.service.uploadStaged(f.scope, { ...f.input('fake.mp4', fake.length), mimeType: 'video/mp4' }, stream(fake), f.signal)).rejects.toThrow('not attached')
    await expect(f.service.uploadStaged(f.scope, { ...f.input('typed.mp4', video.length), mimeType: 'video/webm' }, stream(video), f.signal)).rejects.toThrow('does not match')
    // A binary name cannot carry a media type the desktop readers own.
    await expect(f.service.uploadStaged(f.scope, { ...f.input('doc.bin', LARGE), mimeType: 'application/pdf' }, body(LARGE / MB).stream, f.signal)).rejects.toThrow('not supported')
    expect(await f.files()).toEqual([saved.conversion.stagedRef!.slice('chat-uploads/'.length)])
    expect(await f.leftSpools()).toEqual([])
    expect((await desktopDocumentStore(f.db).list(f.scope)).map(record => record.attachment.name)).toEqual(['clip.mp4'])
}, 60_000)

it('the route refuses a missing or over-limit length and a mismatched header before reading the body', async () => {
    const f = await fixture(), api = desktopDocumentStagedUploadApi(f.service), megabytes = LARGE / MB
    const call = async (headers: Record<string, string>, source = body(megabytes), agentId = f.scope.agentId) => {
        const request = new Request('http://127.0.0.1:1111/staged', { method: 'POST', headers, body: source.stream, duplex: 'half' } as RequestInit)
        const result = await api(request, agentId).then(async response => ({ status: response.status, body: await response.json() as { attachment?: { name: string } } }), error => ({ status: (error as { status: number }).status, message: (error as Error).message }))
        return { result, source }
    }
    const header = (value: object) => encodeURIComponent(JSON.stringify(value))
    const good = (name = 'données.zip') => ({ 'content-length': String(LARGE), [DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER]: header(f.input(name, LARGE)) })
    for (const [headers, status] of [
        [{ [DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER]: good()[DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER]! }, 411],
        [{ ...good(), 'content-length': String(DESKTOP_DOCUMENT_STAGED_MAX_BYTES + 1) }, 413],
        [{ ...good(), 'content-length': String(LARGE + 1) }, 400],
        [{ 'content-length': String(LARGE) }, 400],
        [{ 'content-length': String(LARGE), [DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER]: '%7Bnot json' }, 400],
        [{ 'content-length': String(LARGE), [DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER]: header({ ...f.input('a.zip', LARGE), extra: true }) }, 400],
    ] as const) {
        const { result, source } = await call(headers)
        expect(result.status).toBe(status)
        expect(source.state.pulled).toBe(0)
    }
    const over = await call({ ...good(), 'content-length': String(DESKTOP_DOCUMENT_STAGED_MAX_BYTES + 1) })
    expect(over.result).toMatchObject({ status: 413, message: 'Files saved to a coworker’s Files can be up to 100 MB.' })
    // Another coworker's route cannot be used for this coworker's conversation.
    expect((await call(good(), body(megabytes), f.other.id)).result.status).toBe(409)
    const saved = await call(good())
    expect(saved.result).toMatchObject({ status: 200, body: { attachment: { name: 'données.zip', byteLength: LARGE, uploaded: true } } })
    expect(await f.files()).toHaveLength(1)
    expect(await f.leftSpools()).toEqual([])
}, 60_000)
