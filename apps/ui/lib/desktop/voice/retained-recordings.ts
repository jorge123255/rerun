'use client'

import type { DesktopVoiceDraft, DesktopVoiceScope } from '@rerun/contracts'
import { holdDraftAdmission } from '@/lib/desktop/draft-writes'
import { uploadDesktopVoice } from './client'
import type { DesktopVoiceRecordingTake } from './useDesktopVoiceRecorder'

export type RetainedVoiceRecording = {
    scope: DesktopVoiceScope
    attemptId: string
    take: DesktopVoiceRecordingTake | null
    draft: DesktopVoiceDraft | null
    error: string | null
    pending: boolean
    capture: Promise<DesktopVoiceRecordingTake | null>
    work: Promise<DesktopVoiceDraft | null> | null
    release: () => void
}
const records = new Map<string, RetainedVoiceRecording>()
const listeners = new Set<(record: RetainedVoiceRecording) => void>()
export const voiceScopeKey = (scope: DesktopVoiceScope) => JSON.stringify([scope.agentId, scope.tabUid, scope.sessionId ?? null])
export const retainedVoiceRecording = (scope: DesktopVoiceScope) => records.get(voiceScopeKey(scope)) ?? null
export const canRetainVoiceRecording = () => records.size < 8
export function subscribeRetainedVoice(listener: (record: RetainedVoiceRecording) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(record: RetainedVoiceRecording) { for (const listener of listeners) listener(record) }

export function saveRetainedVoice(record: RetainedVoiceRecording): Promise<DesktopVoiceDraft | null> {
    if (record.draft) return Promise.resolve(record.draft)
    if (record.work) return record.work
    record.pending = true; record.error = null
    publish(record)
    const work = (async () => {
        try {
            try { record.take ??= await record.capture }
            catch { record.error = 'Recording could not be recovered.'; records.delete(voiceScopeKey(record.scope)); record.release(); return null }
            if (!record.take) {
                record.error = 'Nothing was recorded.'
                records.delete(voiceScopeKey(record.scope))
                record.release()
                return null
            }
            record.draft = await uploadDesktopVoice(record.scope, record.attemptId, record.take, AbortSignal.timeout(25_000))
            record.take = null
            record.capture = Promise.resolve(null)
            records.delete(voiceScopeKey(record.scope))
            record.release()
            return record.draft
        } catch (error) {
            record.error = error instanceof Error ? error.message : 'Recording could not be saved. Retry this recording before leaving the app.'
            return null
        } finally {
            record.pending = false
            record.work = null
            publish(record)
        }
    })()
    record.work = work
    return work
}

export function retainVoiceRecording(scope: DesktopVoiceScope, capture: () => Promise<DesktopVoiceRecordingTake | null>): RetainedVoiceRecording {
    const previous = retainedVoiceRecording(scope)
    if (previous) { void capture().catch(() => {}); return previous }
    const record: RetainedVoiceRecording = {
        scope: { ...scope }, attemptId: crypto.randomUUID(), take: null, draft: null, error: null, pending: true,
        capture: Promise.resolve(null), work: null, release: holdDraftAdmission(),
    }
    records.set(voiceScopeKey(scope), record)
    try { record.capture = capture() } catch (error) { record.capture = Promise.reject(error) }
    void saveRetainedVoice(record)
    return record
}
