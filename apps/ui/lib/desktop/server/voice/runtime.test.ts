import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopVoiceScope } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
vi.mock('server-only', () => ({}))
import { createDesktopVoiceRuntime, type VoiceBackendPorts } from './runtime'
import { desktopVoiceDispatches } from './storage'

const attemptId = '11111111-1111-4111-8111-111111111111'
const scope: DesktopVoiceScope = { agentId: 'owner', tabUid: 'tab', sessionId: 'session' }
const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, ...new TextEncoder().encode('webm')])
const format = { mimeType: 'audio/webm;codecs=opus', extension: 'webm' as const, transcriptionFormat: 'webm' as const }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture(initial: DesktopVoiceScope = scope) {
    const folder = await mkdtemp(join(tmpdir(), 'rerun-voice-runtime-')), url = `file:${join(folder, 'voice.db')}`
    let db: Client = createClient({ url })
    cleanup.push(async () => { db.close(); await rm(folder, { recursive: true, force: true }) })
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
      CREATE TABLE desktop_agents(id TEXT PRIMARY KEY,workspace_id INTEGER,engine_agent_id TEXT,name TEXT,description TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TABLE desktop_space_placements(agent_id TEXT,col INTEGER,row INTEGER,space_id TEXT);
      CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY,agent_id TEXT,engine_session_id TEXT,title TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE desktop_deletions(agent_id TEXT,completed INTEGER);
      CREATE TABLE desktop_agent_tabs(agent_id TEXT PRIMARY KEY,revision INTEGER,layout TEXT);
      CREATE TABLE desktop_tab_starts(agent_id TEXT,uid TEXT,engine_session_id TEXT,run_id TEXT);
      CREATE TABLE desktop_queued_messages(agent_id TEXT,payload TEXT);
      CREATE TABLE desktop_composer_drafts(agent_id TEXT,text TEXT);
      INSERT INTO desktop_agents VALUES('owner',1,'engine-owner','Voice','',1,'now','now');
      INSERT INTO desktop_agents VALUES('sibling',1,'engine-sibling','Sibling','',1,'now','now');
      INSERT INTO desktop_sessions VALUES('session','owner','engine-session','Voice','now','now');
      INSERT INTO desktop_sessions VALUES('other-session','sibling','engine-other','Other','now','now');`)
    const layout = async (tabs = [{ uid: initial.tabUid, id: initial.sessionId ?? null }]) => db.execute({ sql: 'INSERT OR REPLACE INTO desktop_agent_tabs(agent_id,revision,layout) VALUES(?,1,?)', args: [initial.agentId, JSON.stringify({ tabs, activeIndex: 0 })] })
    await layout()
    const runtime: DesktopRuntime = { protocolVersion: 1, launchNonce: 'launch', buildId: 'build', workspaceId: 1, dataRoot: folder, app: { origin: 'http://127.0.0.1:1111', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:2222', apiKey: 'fixture' } }
    let enabled = true, lost = false, admissions = 0, active = true
    const saved = new Map<string, { text: string; sessionId: string; runId: string }>()
    const messages: Array<{ id: string; role: string; contentJson: string }> = []
    const startChat: VoiceBackendPorts['startChat'] = vi.fn(async (_runtime, input) => {
        if (!('text' in input)) throw new Error('unexpected regeneration')
        const key = input.requestId ?? input.tabUid!, existing = saved.get(key)
        if (existing && existing.text !== input.text) throw new Error('conflict')
        const sessionId = input.sessionId ?? 'first-session', runId = input.requestId ?? 'first-run'
        if (!existing) {
            admissions++
            saved.set(key, { text: input.text, sessionId, runId })
            if (!input.sessionId) {
                await db.execute("INSERT INTO desktop_sessions VALUES('first-session','owner','engine-first','Voice','now','now')")
                await db.execute({ sql: "INSERT INTO desktop_tab_starts VALUES('owner',?,'engine-first','first-run')", args: [input.tabUid!] })
            }
            messages.push({ id: 'message-voice', role: 'user', contentJson: JSON.stringify([{ type: 'text', text: input.text }]) })
        }
        if (lost) { lost = false; throw new Error('ack lost') }
        return { sessionId, response: new Response('data: [DONE]\n\n', { headers: { 'x-session-id': sessionId, 'x-run-id': runId } }) }
    })
    const ports: Partial<VoiceBackendPorts> = {
        agent: async id => ({ id, enabled }),
        run: async (agentId, id) => ({ id, agentId, sessionId: initial.sessionId ? 'engine-session' : 'engine-first' }),
        messages: async () => messages,
        transcriptionAvailable: async () => true, transcribe: async () => 'Hello from voice', startChat, isCurrent: () => active,
    }
    let service = await createDesktopVoiceRuntime(runtime, db, ports)
    const signal = new AbortController().signal
    const ready = async () => {
        const uploaded = await service.upload(initial, { ...initial, attemptId, format, durationMs: 1200, levels: [0.1, 0.5] }, bytes, signal)
        return service.transcribe(initial, { ...initial, attemptId, expectedRevision: uploaded.revision }, signal)
    }
    return { get db() { return db }, get service() { return service }, runtime, ports, initial, signal, ready, layout, messages, startChat,
        lost: () => { lost = true }, disabled: () => { enabled = false }, invalidate: () => { active = false }, admissions: () => admissions,
        restart: async () => { db.close(); db = createClient({ url }); service = await createDesktopVoiceRuntime(runtime, db, ports); return service } }
}
it('persists real immutable bytes and send receipt across reopen, with one canonical queued admission', async () => {
    const f = await fixture(), ready = await f.ready()
    const input = { ...scope, attemptId, expectedRevision: ready.revision }
    const sent = await f.service.send(scope, input, f.signal)
    expect(sent.dispatch).toEqual({ sessionId: 'session', runId: attemptId })
    const service = await f.restart()
    expect((await service.send(scope, input, f.signal)).dispatch).toEqual(sent.dispatch)
    expect((await service.audio(scope, attemptId, f.signal)).bytes).toEqual(bytes)
    expect(f.admissions()).toBe(1); expect(f.startChat).toHaveBeenCalledTimes(1)
})
it.each([scope, { agentId: 'owner', tabUid: 'new-tab' }])('recovers a lost acknowledgement without changing the original scope or admission: %j', async original => {
    const f = await fixture(original), ready = await f.ready(); f.lost()
    const choice = original.sessionId ? {} : { modelChoice: { connectionId: 'codex', model: 'terra' } }
    await expect(f.service.send(original, { ...original, attemptId, expectedRevision: ready.revision, ...choice }, f.signal)).rejects.toThrow('acknowledgement')
    const service = await f.restart(), draft = await service.draft(original, attemptId, f.signal)
    const sent = await service.send(original, { ...original, attemptId, expectedRevision: draft!.revision, ...choice }, f.signal)
    expect(sent.draft.scope).toEqual(original)
    expect(sent.dispatch?.runId).toBe(original.sessionId ? attemptId : 'first-run')
    expect(f.admissions()).toBe(1)
    const row = await desktopVoiceDispatches(f.db).read(original, attemptId)
    expect(row?.dispatch).toEqual(sent.dispatch)
    if (!original.sessionId) {
        await expect(service.send(original, { ...original, attemptId, expectedRevision: draft!.revision, modelChoice: { connectionId: 'codex', model: 'other' } }, f.signal)).rejects.toThrow('changed')
        expect(f.startChat).toHaveBeenLastCalledWith(f.runtime, expect.objectContaining({ tabUid: original.tabUid, modelChoice: { connectionId: 'codex', model: 'terra' } }))
    }
})
it('permits saved-message playback after its tab closes but denies mutations and forged references', async () => {
    const f = await fixture(), ready = await f.ready()
    await f.service.send(scope, { ...scope, attemptId, expectedRevision: ready.revision }, f.signal)
    await f.layout([{ uid: 'replacement', id: 'session' }])
    expect((await f.service.audio(scope, attemptId, f.signal)).bytes).toEqual(bytes)
    await expect(f.service.draft(scope, attemptId, f.signal)).rejects.toThrow('no longer current')
    await expect(f.service.audio({ ...scope, agentId: 'sibling' }, attemptId, f.signal)).rejects.toThrow()
    f.messages[0]!.contentJson = JSON.stringify([{ type: 'text', text: 'another message' }])
    await expect(f.service.audio(scope, attemptId, f.signal)).rejects.toThrow()
})
it('denies sibling sessions, closed tabs, disabled owners and obsolete runtime before chat dispatch', async () => {
    const f = await fixture(), ready = await f.ready()
    await expect(f.service.upload({ ...scope, sessionId: 'other-session' }, { ...scope, sessionId: 'other-session', attemptId, format, durationMs: 1200, levels: [] }, bytes, f.signal)).rejects.toThrow()
    f.disabled()
    await expect(f.service.send(scope, { ...scope, attemptId, expectedRevision: ready.revision }, f.signal)).rejects.toThrow()
    expect(f.startChat).not.toHaveBeenCalled()
    f.invalidate()
    await expect(f.service.audio(scope, attemptId, f.signal)).rejects.toThrow()
})
it('never deletes audio for a pending uncertain dispatch and retains its exact chosen model', async () => {
    const original = { agentId: 'owner', tabUid: 'new-tab' }, f = await fixture(original), ready = await f.ready(); f.lost()
    await expect(f.service.send(original, { ...original, attemptId, expectedRevision: ready.revision, modelChoice: { connectionId: 'codex', model: 'terra' } }, f.signal)).rejects.toThrow()
    const draft = await f.service.draft(original, attemptId, f.signal)
    await expect(f.service.discard(original, { ...original, attemptId, expectedRevision: draft!.revision }, f.signal)).rejects.toThrow('referenced')
    const sent = await f.service.send(original, { ...original, attemptId, expectedRevision: draft!.revision }, f.signal)
    expect(sent.dispatch?.runId).toBe('first-run')
    expect(f.admissions()).toBe(1)
})
it('restores original first-tab drafts through only their exact bound-session alias and preserves model intent', async () => {
    const original = { agentId: 'owner', tabUid: 'new-tab' }, f = await fixture(original), ready = await f.ready(); f.lost()
    await expect(f.service.send(original, { ...original, attemptId, expectedRevision: ready.revision, modelChoice: { connectionId: 'codex', model: 'terra' } }, f.signal)).rejects.toThrow()
    const service = await f.restart(), selected = { ...original, sessionId: 'first-session' }
    const restored = await service.list(selected, f.signal)
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ scope: original, sendModelChoice: { connectionId: 'codex', model: 'terra' } })
    expect((await service.draft(selected, attemptId, f.signal))?.scope).toEqual(original)
    await expect(service.list({ ...selected, sessionId: 'session' }, f.signal)).rejects.toThrow()
    const sent = await service.send(restored[0]!.scope, { ...restored[0]!.scope, attemptId, expectedRevision: restored[0]!.revision }, f.signal)
    expect(sent.dispatch?.sessionId).toBe('first-session'); expect(f.admissions()).toBe(1)
})
it('recovers an exact accepted but unacknowledged send for history playback after the original tab closes', async () => {
    const original = { agentId: 'owner', tabUid: 'new-tab' }, f = await fixture(original), ready = await f.ready(); f.lost()
    await expect(f.service.send(original, { ...original, attemptId, expectedRevision: ready.revision }, f.signal)).rejects.toThrow()
    await f.layout([{ uid: 'replacement', id: 'first-session' }])
    const service = await f.restart()
    expect((await service.audio(original, attemptId, f.signal)).bytes).toEqual(bytes)
    expect((await desktopVoiceDispatches(f.db).read(original, attemptId))?.dispatch).toEqual({ sessionId: 'first-session', runId: 'first-run' })
    expect(f.admissions()).toBe(1); expect(f.startChat).toHaveBeenCalledTimes(1)
})
