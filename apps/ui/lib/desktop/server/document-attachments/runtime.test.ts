import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { foremanDocumentScope, type DesktopDocumentScope } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
vi.mock('server-only', () => ({}))
import { createDesktopDocumentRuntime } from './runtime'
import { DESKTOP_FOREMAN_CHAT_SCHEMA, ensureForemanChat } from '../foreman/chat-store'
import { setDesktopWorkspaceFrozen } from '../workspace-admission'
const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(close => close()) })
async function fixture(workspaceId = 1) {
    const directory = mkdtempSync(join(tmpdir(), 'rerun-doc-runtime-'))
    const url = `file:${join(directory, 'app.db')}`
    const db = createClient({ url }); cleanup.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
      CREATE TABLE desktop_agents(id TEXT PRIMARY KEY,workspace_id INTEGER,engine_agent_id TEXT,name TEXT,description TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TABLE desktop_space_placements(agent_id TEXT,col INTEGER,row INTEGER,space_id TEXT);
      CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY,agent_id TEXT,engine_session_id TEXT,title TEXT,created_at TEXT,updated_at TEXT,model_connection_id TEXT,model TEXT);
      CREATE TABLE desktop_deletions(agent_id TEXT,completed INTEGER);
      CREATE TABLE desktop_agent_tabs(agent_id TEXT PRIMARY KEY,revision INTEGER,layout TEXT);
      CREATE TABLE desktop_tab_starts(agent_id TEXT,uid TEXT,engine_session_id TEXT,run_id TEXT);
      CREATE TABLE desktop_queued_messages(agent_id TEXT,payload TEXT);
      CREATE TABLE desktop_composer_drafts(agent_id TEXT,text TEXT);
      INSERT INTO desktop_agents VALUES('owner',1,'engine-owner','Documents','',1,'now','now');
      INSERT INTO desktop_sessions VALUES('first-session','owner','engine-session','First','now','now',NULL,NULL);
      INSERT INTO desktop_sessions VALUES('other-session','owner','engine-other','Other','now','now',NULL,NULL);`)
    const scope: DesktopDocumentScope = { agentId: 'owner', tabUid: 'tab' }
    const layout = (id: string | null, uid = 'tab') => db.execute({ sql: 'INSERT OR REPLACE INTO desktop_agent_tabs VALUES(?,1,?)', args: ['owner', JSON.stringify({ tabs: [{ uid, id }], activeIndex: 0 })] })
    await layout(null)
    const runtime: DesktopRuntime = { protocolVersion: 1, launchNonce: 'launch', buildId: 'build', workspaceId, dataRoot: '/fixture', app: { origin: 'http://127.0.0.1:1111', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:2222', apiKey: 'fixture' } }
    let current = true, mutate: (() => Promise<void>) | undefined
    const service = await createDesktopDocumentRuntime(runtime, db, { isCurrent: () => current, agent: async id => { if (mutate) await mutate(); return { id, enabled: true } } })
    const signal = new AbortController().signal
    const upload = () => service.upload(scope, { ...scope, attachmentId: randomUUID(), name: 'archive.zip', mimeType: 'application/octet-stream', position: 0 }, new Uint8Array([1, 2, 3]), signal)
    return { db, url, runtime, service, scope, signal, layout, upload, invalidate: () => { current = false }, mutate: (callback: () => Promise<void>) => { mutate = callback } }
}
it.each([1, 2])('accepts the assigned database local owner row in runtime workspace %i', async workspaceId => {
    const f = await fixture(workspaceId)
    expect(await f.service.list(f.scope, f.signal)).toEqual([])
    const attachment = await f.upload()
    expect((await f.service.list(f.scope, f.signal)).map(item => item.attachmentId)).toEqual([attachment.attachmentId])
    expect((await f.service.read(f.scope, attachment.attachmentId, attachment.sha256, f.signal)).bytes).toEqual(new Uint8Array([1, 2, 3]))
    await expect(f.service.list({ ...f.scope, agentId: 'sibling' }, f.signal)).rejects.toThrow()
})
it('rejects a row stored under another workspace id even when that id equals the runtime', async () => {
    const f = await fixture(2)
    await f.db.execute("UPDATE desktop_agents SET workspace_id=2 WHERE id='owner'")
    await expect(f.service.list(f.scope, f.signal)).rejects.toThrow()
    await expect(f.upload()).rejects.toThrow()
})
it('does not read an owner that exists only in another workspace database', async () => {
    const home = await fixture(1)
    const other = await fixture(2)
    await home.db.execute("INSERT INTO desktop_agents VALUES('only-home',1,'engine-home','Home','',1,'now','now')")
    await expect(other.service.list({ ...other.scope, agentId: 'only-home' }, other.signal)).rejects.toThrow()
    expect(await home.service.list(home.scope, home.signal)).toEqual([])
})
it('restores only the authenticated first-turn alias and keeps immutable read scope', async () => {
    const f = await fixture(), a = await f.upload()
    await f.db.execute("INSERT INTO desktop_tab_starts VALUES('owner','tab','engine-session','first-run')")
    await f.layout('first-session')
    expect((await f.service.list({ ...f.scope, sessionId: 'first-session' }, f.signal))[0]?.scope).toEqual(f.scope)
    expect((await f.service.read(f.scope, a.attachmentId, a.sha256, f.signal)).bytes).toEqual(new Uint8Array([1, 2, 3]))
    await f.layout('other-session')
    expect(await f.service.list({ ...f.scope, sessionId: 'other-session' }, f.signal)).toEqual([])
    await expect(f.service.read(f.scope, a.attachmentId, a.sha256, f.signal)).rejects.toThrow('no longer available')
})
it('rejects owner replacement during the engine lookup and stale runtime before publication', async () => {
    const f = await fixture()
    f.mutate(async () => { await f.db.execute("UPDATE desktop_agents SET engine_agent_id='replacement' WHERE id='owner'") })
    await expect(f.upload()).rejects.toThrow('no longer available')
    expect((await f.db.execute('SELECT COUNT(*) AS count FROM desktop_document_attachments')).rows[0]?.count).toBe(0)
    f.invalidate()
    await expect(f.service.list(f.scope, f.signal)).rejects.toThrow('app session changed')
})
it('keeps Chief of Staff attachments scoped to the managed conversation and available after database reopen', async () => {
    const f = await fixture(2)
    await f.db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA)
    const { chat, sessionId } = await ensureForemanChat(f.db, '2')
    const scope = foremanDocumentScope(chat, sessionId)
    const service = await createDesktopDocumentRuntime(f.runtime, f.db, undefined, 'foreman')
    const bytes = new TextEncoder().encode('Owned Chief of Staff document')
    const attachment = await service.upload(scope, {
        ...scope, attachmentId: randomUUID(), name: 'brief.txt', mimeType: 'text/plain', position: 0,
    }, bytes, f.signal)
    const selection = { admissionId: randomUUID(), attachmentIds: [attachment.attachmentId] }
    expect((await service.admission(scope, selection, f.signal)).inputs).toEqual([{ mode: 'text', text: 'Owned Chief of Staff document' }])
    await expect(f.service.list(scope, f.signal)).rejects.toThrow('no longer available')
    await expect(service.read({ ...scope, sessionId: randomUUID() }, attachment.attachmentId, attachment.sha256, f.signal)).rejects.toThrow()
    setDesktopWorkspaceFrozen(f.runtime, true)
    try { await expect(service.consume(scope, selection.admissionId, f.signal)).rejects.toThrow('workspace is switching') }
    finally { setDesktopWorkspaceFrozen(f.runtime, false) }
    await service.consume(scope, selection.admissionId, f.signal)
    const reopened = createClient({ url: f.url })
    try {
        const restored = await createDesktopDocumentRuntime(f.runtime, reopened, undefined, 'foreman')
        expect(await restored.list(scope, f.signal)).toEqual([])
        expect((await restored.read(scope, attachment.attachmentId, attachment.sha256, f.signal)).bytes).toEqual(bytes)
        const foreign = await createDesktopDocumentRuntime({ ...f.runtime, workspaceId: 3 }, reopened, undefined, 'foreman')
        await expect(foreign.read(scope, attachment.attachmentId, attachment.sha256, f.signal)).rejects.toThrow()
    } finally { reopened.close() }
})
