import { expect, test, vi } from 'vitest'
import type { DesktopVoiceDraft } from '@rerun/contracts'

const ports = vi.hoisted(() => ({ upload: vi.fn(), holds: 0 }))
vi.mock('./client', () => ({ uploadDesktopVoice: (...args: unknown[]) => ports.upload(...args) }))
vi.mock('@/lib/desktop/draft-writes', () => ({ holdDraftAdmission: () => { ports.holds++; let released = false; return () => { if (!released) { released = true; ports.holds-- } } } }))
import { retainVoiceRecording, retainedVoiceRecording, saveRetainedVoice } from './retained-recordings'

test('quit admission is acquired before recorder stop and retained through failed save until exact durable recovery', async () => {
    const scope = { agentId: 'owner', tabUid: 'retained-quit-test' }
    const take = { blob: new Blob(['audio']), durationMs: 1000, levels: [], format: { mimeType: 'audio/webm', extension: 'webm' as const, transcriptionFormat: 'webm' as const } }
    ports.upload.mockRejectedValueOnce(new Error('Lost acknowledgement'))
    const record = retainVoiceRecording(scope, async () => { expect(ports.holds).toBe(1); return take })
    expect(await saveRetainedVoice(record)).toBeNull()
    expect(retainedVoiceRecording(scope)).toBe(record)
    expect(record.take).toBe(take)
    expect(ports.holds).toBe(1)
    const saved = { attemptId: record.attemptId, scope, phase: 'review', revision: crypto.randomUUID(), recording: { attemptId: record.attemptId }, transcript: null } as DesktopVoiceDraft
    ports.upload.mockResolvedValue(saved)
    expect(await saveRetainedVoice(record)).toBe(saved)
    expect(ports.upload.mock.calls.every(call => call[0] === record.scope && call[1] === record.attemptId && call[2] === take)).toBe(true)
    expect(ports.holds).toBe(0)
    expect(retainedVoiceRecording(scope)).toBeNull()
})

test('an empty recording releases its quit admission without uploading', async () => {
    ports.upload.mockClear()
    const record = retainVoiceRecording({ agentId: 'owner', tabUid: 'empty-quit-test' }, async () => null)
    expect(await saveRetainedVoice(record)).toBeNull()
    expect(ports.holds).toBe(0)
    expect(ports.upload).not.toHaveBeenCalled()
})
