import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopVoiceRecording, DesktopVoiceScope } from '@rerun/contracts'
vi.mock('server-only', () => ({}))
import { desktopVoiceStore, ensureDesktopVoiceSchema } from './store'
import { desktopVoiceBlobs, desktopVoiceDispatches, DESKTOP_VOICE_OWNER_BYTES, voiceRecordingJson } from './storage'
import type { DesktopVoiceAttemptRecord } from './types'

const scope: DesktopVoiceScope = { agentId: 'owner', tabUid: 'tab', sessionId: 'session' }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const recording = (bytes: Uint8Array, attemptId = randomUUID()): DesktopVoiceRecording => ({ attemptId, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm', durationMs: 1000, levels: [] })
const attempt = (recording: DesktopVoiceRecording): DesktopVoiceAttemptRecord => ({ fingerprint: JSON.stringify(recording), draft: { attemptId: recording.attemptId, scope, recording, revision: randomUUID(), phase: 'uploading', transcript: null, error: null, messageId: null, updatedAt: 'now' } })
async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), 'rerun-voice-bytes-')), url = `file:${join(folder, 'voice.db')}`
    let db: Client = createClient({ url })
    cleanup.push(async () => { db.close(); await rm(folder, { recursive: true, force: true }) })
    await db.executeMultiple("PRAGMA foreign_keys=ON; CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner'); INSERT INTO desktop_agents VALUES('sibling');")
    await ensureDesktopVoiceSchema(db)
    return { get db() { return db }, reopen: () => { db.close(); db = createClient({ url }); return db } }
}
it('keeps exact bytes across database reopen and refuses sibling scope, changed metadata and corrupt replacements', async () => {
    const f = await fixture(), bytes = Uint8Array.from([1, 2, 3, 4]), rec = recording(bytes), value = attempt(rec), signal = new AbortController().signal
    const store = desktopVoiceStore(f.db), blobs = desktopVoiceBlobs(f.db)
    await store.reserve(value); await blobs.put(scope, rec, bytes, signal)
    const reopened = desktopVoiceBlobs(f.reopen())
    expect(await reopened.read(scope, rec, signal)).toEqual(bytes)
    await expect(reopened.read({ ...scope, agentId: 'sibling' }, rec, signal)).rejects.toThrow()
    await expect(reopened.read({ ...scope, sessionId: 'other' }, rec, signal)).rejects.toThrow()
    await expect(reopened.put(scope, { ...rec, durationMs: 2000 }, bytes, signal)).rejects.toThrow()
    await f.db.execute({ sql: 'UPDATE desktop_voice_blobs SET bytes=? WHERE attempt_id=?', args: [Uint8Array.from([9, 9, 9, 9]), rec.attemptId] })
    await expect(reopened.read(scope, rec, signal)).rejects.toThrow()
    await expect(reopened.put(scope, rec, bytes, signal)).rejects.toThrow()
})
it('requires a durable discard reservation and never deletes bytes referenced by a pending send', async () => {
    const f = await fixture(), bytes = Uint8Array.from([1, 2]), rec = recording(bytes), value = attempt(rec), signal = new AbortController().signal
    const store = desktopVoiceStore(f.db), blobs = desktopVoiceBlobs(f.db), dispatches = desktopVoiceDispatches(f.db)
    await store.reserve(value); await blobs.put(scope, rec, bytes, signal)
    await expect(blobs.delete(scope, rec, signal)).rejects.toThrow()
    const sending = { ...value, draft: { ...value.draft, phase: 'sending' as const, revision: randomUUID() } }
    await store.save(sending, value.draft.revision)
    const input = { scope, attemptId: rec.attemptId, text: 'exact voice message', recording: rec }
    await dispatches.reserve(input, 'engine-owner')
    await f.db.execute({ sql: "UPDATE desktop_voice_attempts SET phase='discarding' WHERE attempt_id=?", args: [rec.attemptId] })
    await expect(blobs.delete(scope, rec, signal)).rejects.toThrow()
    expect(await blobs.read(scope, rec, signal)).toEqual(bytes)
})
it('retains immutable dispatch identity and terminal receipt across reopen, including selected model and engine owner', async () => {
    const f = await fixture(), bytes = Uint8Array.from([1]), rec = recording(bytes), value = attempt(rec)
    value.draft.phase = 'sending'
    await desktopVoiceStore(f.db).reserve(value)
    let ledger = desktopVoiceDispatches(f.db)
    const input = { scope, attemptId: rec.attemptId, text: 'same text', recording: rec, modelChoice: { connectionId: 'codex', model: 'terra' } }
    const reserved = await ledger.reserve(input, 'engine-owner')
    ledger = desktopVoiceDispatches(f.reopen())
    expect((await ledger.reserve({ ...input, modelChoice: undefined }, 'engine-owner')).modelChoice).toEqual(input.modelChoice)
    await expect(ledger.reserve({ ...input, text: 'changed' }, 'engine-owner')).rejects.toThrow()
    await expect(ledger.reserve(input, 'replacement-engine')).rejects.toThrow()
    await expect(ledger.reserve({ ...input, modelChoice: { ...input.modelChoice, model: 'other' } }, 'engine-owner')).rejects.toThrow()
    const dispatch = { sessionId: 'session', runId: rec.attemptId }
    await ledger.complete(scope, rec.attemptId, reserved.fingerprint, dispatch, null)
    await ledger.complete(scope, rec.attemptId, reserved.fingerprint, dispatch, null)
    await expect(ledger.complete(scope, rec.attemptId, reserved.fingerprint, { ...dispatch, runId: 'other' }, null)).rejects.toThrow()
    expect((await desktopVoiceDispatches(f.reopen()).read(scope, rec.attemptId))?.dispatch).toEqual(dispatch)
})
it('enforces byte budget on new blobs while preserving existing acknowledged recordings', async () => {
    const f = await fixture(), signal = new AbortController().signal, chunk = new Uint8Array(2 * 1024 * 1024)
    const store = desktopVoiceStore(f.db), blobs = desktopVoiceBlobs(f.db)
    for (let index = 0; index < DESKTOP_VOICE_OWNER_BYTES / chunk.byteLength; index++) {
        const rec = recording(chunk); await store.reserve(attempt(rec))
        await f.db.execute({ sql: 'INSERT INTO desktop_voice_blobs VALUES(?,?,?,?,?,?,?,zeroblob(?))', args: [rec.attemptId, scope.agentId, scope.tabUid, scope.sessionId!, voiceRecordingJson(rec), rec.sha256, chunk.byteLength, chunk.byteLength] })
    }
    const extra = recording(Uint8Array.from([1])); await store.reserve(attempt(extra))
    await expect(blobs.put(scope, extra, Uint8Array.from([1]), signal)).rejects.toThrow('full')
    expect(Number((await f.db.execute('SELECT SUM(byte_length) AS n FROM desktop_voice_blobs')).rows[0]?.n)).toBe(DESKTOP_VOICE_OWNER_BYTES)
    await expect(f.db.execute({ sql: 'INSERT INTO desktop_voice_blobs VALUES(?,?,?,?,?,?,?,?)', args: [extra.attemptId, scope.agentId, scope.tabUid, scope.sessionId!, voiceRecordingJson(extra), extra.sha256, 2, Uint8Array.from([1])] })).rejects.toThrow()
})
it('serializes concurrent ledger instances on the same SQLite client and returns one stable reservation', async () => {
    const f = await fixture(), rec = recording(Uint8Array.from([1])), value = attempt(rec)
    value.draft.phase = 'sending'
    await desktopVoiceStore(f.db).reserve(value)
    const input = { scope, attemptId: rec.attemptId, text: 'voice', recording: rec }
    const [first, second] = await Promise.all([desktopVoiceDispatches(f.db).reserve(input, 'engine-owner'), desktopVoiceDispatches(f.db).reserve(input, 'engine-owner')])
    expect(first).toEqual(second)
    expect((await f.db.execute('SELECT attempt_id FROM desktop_voice_dispatches')).rows).toHaveLength(1)
})
