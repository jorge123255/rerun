import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { DESKTOP_COWORKER_CALL_INTERRUPTED_REASON, DESKTOP_COWORKER_CALL_MAX_FANOUT } from '../../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import {
    adoptDesktopCoworkerCallEpoch,
    getDesktopCoworkerCall,
    claimDesktopCoworkerCall,
    patchDesktopCoworkerCall,
    initializeDesktopCoworkerCalls,
    insertDesktopCoworkerCall,
    type CoworkerCallRecord,
} from './db'

let root: string
afterEach(async () => { if (root) { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) } })

function record(overrides: Partial<CoworkerCallRecord> = {}): CoworkerCallRecord {
    return {
        callId: crypto.randomUUID(), revision: 1, sourceKey: crypto.randomUUID(), requestFingerprint: '0'.repeat(64), parentAgentId: crypto.randomUUID(), parentSessionId: crypto.randomUUID(),
        parentRunId: crypto.randomUUID(), toolCallId: 'tool-1', targetAgentId: crypto.randomUUID(), targetSessionId: null, targetName: 'Bob', wait: false,
        status: 'queued', phase: 'reserved', launchEpoch: 'epoch-1', launchClaimed: false, engineParentAgentId: 'engine-parent',
        engineParentSessionId: 'engine-parent-session', engineParentRunId: 'engine-parent-run', engineTargetAgentId: 'engine-target',
        engineTargetSessionId: null, engineChildRunId: null, depth: 0, ancestors: [], progress: { steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] },
        pendingToolCallId: null, resultText: null, error: null, stopRequestId: null, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', ...overrides,
    }
}

test('initializer is idempotent, fanout is named, sibling calls share a public parent run, and a new epoch interrupts', async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-coworker-db-'))
    const db = await openDesktopDatabase(root)
    await initializeDesktopCoworkerCalls(db)
    await adoptDesktopCoworkerCallEpoch(db, 'epoch-1', '2026-11-05T00:00:00.000Z')
    await initializeDesktopCoworkerCalls(db)
    await adoptDesktopCoworkerCallEpoch(db, 'epoch-1', '2026-11-05T00:00:00.000Z')
    const parentRun = crypto.randomUUID()
    const first = record({ parentRunId: parentRun })
    const second = record({ parentRunId: crypto.randomUUID(), sourceKey: 'second', toolCallId: 'tool-2', engineParentRunId: first.engineParentRunId })
    expect((await insertDesktopCoworkerCall(db, first)).inserted).toBe(true)
    const shared = await insertDesktopCoworkerCall(db, second)
    expect(shared.inserted).toBe(true)
    if (shared.inserted) expect(shared.row.parentRunId).toBe(parentRun)
    for (let index = 2; index < DESKTOP_COWORKER_CALL_MAX_FANOUT; index += 1) {
        expect((await insertDesktopCoworkerCall(db, record({ sourceKey: `seed-${index}`, toolCallId: `seed-${index}`, engineParentRunId: first.engineParentRunId }))).inserted).toBe(true)
    }
    const refused = await insertDesktopCoworkerCall(db, record({ sourceKey: 'overflow', toolCallId: 'overflow', engineParentRunId: first.engineParentRunId }))
    expect(refused).toEqual({ inserted: false, reason: 'fanout', row: null })
    const again = await insertDesktopCoworkerCall(db, first)
    expect(again.inserted).toBe(false)
    if (!again.inserted) expect(again.reason).toBe('exists')
    await adoptDesktopCoworkerCallEpoch(db, 'epoch-1', '2026-11-05T00:00:01.000Z')
    expect((await getDesktopCoworkerCall(db, first.callId))?.status).toBe('queued')
    await adoptDesktopCoworkerCallEpoch(db, 'epoch-2', '2026-11-05T00:00:02.000Z')
    const interrupted = await getDesktopCoworkerCall(db, first.callId)
    expect(interrupted?.status).toBe('interrupted')
    expect(interrupted?.error).toBe(DESKTOP_COWORKER_CALL_INTERRUPTED_REASON)
    expect(interrupted?.engineParentRunId).toBe('engine-parent-run')
})


test('delayed old-epoch inserts, claims and patches cannot survive restart adoption', async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-coworker-epoch-'))
    const db = await openDesktopDatabase(root)
    await initializeDesktopCoworkerCalls(db)
    await adoptDesktopCoworkerCallEpoch(db, 'epoch-1', '2026-11-05T00:00:00.000Z', 'launch-one')
    const old = record()
    await insertDesktopCoworkerCall(db, old)
    await adoptDesktopCoworkerCallEpoch(db, 'epoch-2', '2026-11-05T00:00:01.000Z', 'launch-two')
    await expect(insertDesktopCoworkerCall(db, record({ sourceKey: 'late' }))).rejects.toThrow('runtime has changed')
    expect(await claimDesktopCoworkerCall(db, old.callId, 'epoch-1', old.updatedAt)).toBeNull()
    expect(await patchDesktopCoworkerCall(db, old.callId, {}, { status: 'running' }, old.updatedAt, 'epoch-1')).toBeNull()
    const fresh = record({ sourceKey: 'fresh', launchEpoch: 'epoch-2' })
    await insertDesktopCoworkerCall(db, fresh)
    expect(await patchDesktopCoworkerCall(db, fresh.callId, {}, { status: 'running' }, fresh.updatedAt, 'epoch-1')).toBeNull()
    await expect(adoptDesktopCoworkerCallEpoch(db, 'epoch-1', old.updatedAt, 'launch-two')).rejects.toThrow('already bound')
    expect((await getDesktopCoworkerCall(db, old.callId))?.status).toBe('interrupted')
    expect((await getDesktopCoworkerCall(db, fresh.callId))?.status).toBe('queued')
})
