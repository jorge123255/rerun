import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_DOCUMENT_MAX_BYTES, desktopStagedDocumentPath, foremanDocumentScope, type DesktopDocumentScope } from '@rerun/contracts'
vi.mock('server-only', () => ({}))
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { createDesktopAgent } from '../store'
import { DESKTOP_FOREMAN_CHAT_SCHEMA, ensureForemanChat } from '../foreman/chat-store'
import { createDesktopDocumentRuntime } from './runtime'
import { desktopDocumentStore } from './store'

// Real database, real Files code and a real folder: the staged copy is checked on disk.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const zip = Uint8Array.from([0x50, 0x4b, 3, 4, 20, 0, 0, 0, 8, 0, 1, 2, 3])
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-staged-'))
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
    const upload = (name = 'archive.zip', bytes: Uint8Array = zip, id: string = randomUUID(), target = scope) => service.upload(target, { ...target, attachmentId: id, name, mimeType: 'application/zip', position: 0 }, bytes, signal)
    const files = (engineId?: string) => readdir(join(workspace(engineId), 'chat-uploads')).catch(() => [] as string[])
    return { root, db, runtime, service, scope, other, signal, workspace, upload, files, disable: () => { enabled = false } }
}

it('saves an archive into the coworker’s own chat-uploads under a collision-free name and admits it by path', async () => {
    const f = await fixture(), first = await f.upload(), second = await f.upload()
    const path = desktopStagedDocumentPath(first.attachmentId, 'archive.zip')
    expect(first).toMatchObject({ kind: 'binary', uploaded: true, conversion: { mode: 'staged-file', state: 'ready', stagedRef: path } })
    expect(path).toMatch(/^chat-uploads\/[0-9a-f]{8}-[0-9a-f]{6}-archive\.zip$/)
    expect(second.conversion.stagedRef).not.toBe(path)
    expect(new Uint8Array(await readFile(join(f.workspace(), path)))).toEqual(zip)
    expect((await lstat(join(f.workspace(), path))).isFile()).toBe(true)
    expect((await f.files()).sort()).toEqual([path, second.conversion.stagedRef!].map(item => item.slice('chat-uploads/'.length)).sort())
    // Nothing reaches the sibling coworker's Files.
    expect(await f.files('engine-b')).toEqual([])
    const admission = await f.service.admission(f.scope, { admissionId: randomUUID(), attachmentIds: [first.attachmentId] }, f.signal)
    expect(admission).toMatchObject({ allowed: true, inputs: [{ mode: 'staged-file', path, reference: { name: 'archive.zip', kind: 'binary', sha256: sha(zip) } }] })
    expect((await f.service.read(f.scope, first.attachmentId, first.sha256, f.signal)).bytes).toEqual(zip)
})

it('a replayed upload finds its own file, and a different file under that name is kept and refused', async () => {
    const f = await fixture(), id = randomUUID(), path = desktopStagedDocumentPath(id, 'archive.zip')
    const first = await f.upload('archive.zip', zip, id)
    // The record was lost after the file was saved: the same attempt completes without a second copy.
    await f.db.execute({ sql: "UPDATE desktop_document_attachments SET uploaded=0, conversion=? WHERE attachment_id=?", args: [JSON.stringify({ mode: 'staged-file', state: 'pending' }), id] })
    expect((await f.upload('archive.zip', zip, id)).conversion).toEqual(first.conversion)
    expect(await f.files()).toHaveLength(1)
    const taken = randomUUID(), takenPath = desktopStagedDocumentPath(taken, 'report.docx')
    await writeFile(join(f.workspace(), takenPath), 'the coworker’s own work')
    await expect(f.upload('report.docx', zip, taken)).rejects.toThrow('already has a file')
    expect(await readFile(join(f.workspace(), takenPath), 'utf8')).toBe('the coworker’s own work')
    expect((await desktopDocumentStore(f.db).read(f.scope, taken))?.attachment.uploaded).toBe(false)
    expect(path).not.toBe(takenPath)
})

it('removing an unsent attachment removes its file; an edited or sent file is kept', async () => {
    const f = await fixture(), a = await f.upload(), b = await f.upload('deck.pptx'), c = await f.upload('sheet.xlsx'), d = await f.upload('clip.bin')
    await f.service.discard(f.scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, f.signal)
    expect(await f.files()).not.toContain(a.conversion.stagedRef!.slice('chat-uploads/'.length))
    await f.service.cancelUpload(f.scope, d.attachmentId, f.signal)
    expect(await f.files()).toHaveLength(2)
    // The coworker (or the person) changed the copy: it is no longer ours to delete, and it is not sent as the attachment.
    await writeFile(join(f.workspace(), b.conversion.stagedRef!), 'edited')
    expect(await f.service.admission(f.scope, { admissionId: randomUUID(), attachmentIds: [b.attachmentId] }, f.signal)).toMatchObject({ allowed: false, inputs: [] })
    await f.service.discard(f.scope, { attachmentId: b.attachmentId, expectedRevision: b.revision }, f.signal)
    expect(await readFile(join(f.workspace(), b.conversion.stagedRef!), 'utf8')).toBe('edited')
    // A sent message keeps its file: the coworker was told the path.
    const selection = { admissionId: randomUUID(), attachmentIds: [c.attachmentId] }
    expect((await f.service.admission(f.scope, selection, f.signal)).allowed).toBe(true)
    await expect(f.service.discard(f.scope, { attachmentId: c.attachmentId, expectedRevision: c.revision }, f.signal)).rejects.toThrow()
    await f.service.consume(f.scope, selection.admissionId, f.signal)
    expect(new Uint8Array(await readFile(join(f.workspace(), c.conversion.stagedRef!)))).toEqual(zip)
    expect(await f.service.admission(f.scope, selection, f.signal)).toMatchObject({ allowed: true, inputs: [{ mode: 'staged-file', path: c.conversion.stagedRef }] })
    expect((await readdir(join(f.workspace(), 'chat-uploads'))).filter(name => name.startsWith('.'))).toEqual([])
})

it('a removed copy blocks the send with a plain reason', async () => {
    const f = await fixture(), a = await f.upload()
    await rm(join(f.workspace(), a.conversion.stagedRef!))
    const admission = await f.service.admission(f.scope, { admissionId: randomUUID(), attachmentIds: [a.attachmentId] }, f.signal)
    expect(admission.allowed).toBe(false)
    expect(admission.reason).toContain('changed or removed')
    await f.service.discard(f.scope, { attachmentId: a.attachmentId, expectedRevision: a.revision }, f.signal)
    expect(await f.service.list(f.scope, f.signal)).toEqual([])
})

it('refuses another coworker’s conversation, a disabled owner and an oversized file before anything is written', async () => {
    const f = await fixture()
    await expect(f.upload('archive.zip', zip, randomUUID(), { agentId: 'missing', tabUid: 'tab' })).rejects.toThrow('no longer available')
    await expect(f.upload('archive.zip', zip, randomUUID(), { agentId: f.other.id, tabUid: 'closed' })).rejects.toThrow('no longer available')
    // A request for one coworker cannot name another's scope.
    await expect(f.service.upload(f.scope, { agentId: f.other.id, tabUid: 'tab', attachmentId: randomUUID(), name: 'archive.zip', mimeType: 'application/zip', position: 0 }, zip, f.signal)).rejects.toThrow()
    await expect(f.upload('big.zip', new Uint8Array(DESKTOP_DOCUMENT_MAX_BYTES + 1).fill(7))).rejects.toThrow('16 MB')
    await expect(f.upload('../escape.zip')).rejects.toThrow()
    await expect(f.upload('.hidden.zip')).rejects.toThrow()
    const saved = await f.upload()
    f.disable()
    await expect(f.upload()).rejects.toThrow('no longer available')
    await expect(f.service.discard(f.scope, { attachmentId: saved.attachmentId, expectedRevision: saved.revision }, f.signal)).rejects.toThrow('no longer available')
    expect(await f.files()).toEqual([saved.conversion.stagedRef!.slice('chat-uploads/'.length)])
    expect(await f.files('engine-b')).toEqual([])
    expect((await f.db.execute('SELECT COUNT(*) AS count FROM desktop_document_attachments')).rows[0]?.count).toBe(1)
})

it('does not follow a chat-uploads folder that is a link to another place', async () => {
    const f = await fixture(), outside = join(f.root, 'outside')
    await mkdir(outside); await mkdir(f.workspace(), { recursive: true })
    await symlink(outside, join(f.workspace(), 'chat-uploads'))
    await expect(f.upload()).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
    expect(await f.service.list(f.scope, f.signal)).toMatchObject([{ uploaded: false, conversion: { state: 'failed' } }])
})

it('Chief of Staff has no Files: the same archive stays download-only', async () => {
    const f = await fixture()
    await f.db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA)
    const { chat, sessionId } = await ensureForemanChat(f.db, '1')
    const scope = foremanDocumentScope(chat, sessionId)
    const service = await createDesktopDocumentRuntime(f.runtime, f.db, undefined, 'foreman')
    const saved = await service.upload(scope, { ...scope, attachmentId: randomUUID(), name: 'archive.zip', mimeType: 'application/zip', position: 0 }, zip, f.signal)
    expect(saved.conversion).toMatchObject({ mode: 'unsupported', state: 'unsupported' })
    expect(await f.files()).toEqual([])
})
