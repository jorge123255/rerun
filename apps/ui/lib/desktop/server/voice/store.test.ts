import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { desktopVoiceStore, ensureDesktopVoiceSchema } from './store'
import type { DesktopVoiceAttemptRecord } from './types'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

it('persists discard reservation and tombstone across reopen, rejects stale saves, and binds the session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rerun-voice-store-'))
    const url = `file:${join(directory, 'voice.sqlite')}`
    let db: Client = createClient({ url })
    cleanup.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
    await db.execute('CREATE TABLE desktop_agents(id TEXT PRIMARY KEY)')
    await db.execute("INSERT INTO desktop_agents(id) VALUES('owner')")
    await ensureDesktopVoiceSchema(db)
    const scope = { agentId: 'owner', tabUid: 'tab', sessionId: 'session' }
    const attemptId = '11111111-1111-4111-8111-111111111111'
    const revision = '22222222-2222-4222-8222-222222222222'
    const record: DesktopVoiceAttemptRecord = {
        fingerprint: 'exact-upload',
        draft: { attemptId, scope, phase: 'ready', revision, transcript: 'retained', error: null, messageId: null, updatedAt: '2026-11-05T00:00:00Z',
            recording: { attemptId, sha256: 'a'.repeat(64), byteLength: 4, mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm', durationMs: 1000, levels: [] } },
    }
    let store = desktopVoiceStore(db)
    await store.reserve(record)
    expect(await store.read({ ...scope, sessionId: 'different' }, attemptId)).toBeNull()
    await store.reserveDiscard(scope, attemptId, revision)
    db.close(); db = createClient({ url }); store = desktopVoiceStore(db)
    expect((await store.read(scope, attemptId))?.deletion).toBe('pending')
    await expect(store.save({ ...record, draft: { ...record.draft, phase: 'sending' } }, revision)).rejects.toThrow('revision conflict')
    await expect(store.discard(scope, attemptId, '33333333-3333-4333-8333-333333333333')).rejects.toThrow('revision conflict')
    await store.discard(scope, attemptId, revision)
    db.close(); db = createClient({ url }); store = desktopVoiceStore(db)
    expect(await store.list(scope)).toEqual([])
    const replay = await store.reserve(record)
    expect(replay.created).toBe(false)
    expect(replay.record.deletion).toBe('complete')
    await store.discard(scope, attemptId, revision)
})
