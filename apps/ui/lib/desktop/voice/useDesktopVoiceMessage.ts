'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopVoiceDraft, DesktopVoiceLifecycle, DesktopVoiceScope, DesktopVoiceSendReceipt, DesktopVoiceRevisionAction } from '@rerun/contracts'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { discardDesktopVoice, listDesktopVoiceDrafts, readDesktopVoiceDraft, sendDesktopVoice, transcribeDesktopVoice } from './client'
import { canRetainVoiceRecording, retainVoiceRecording, retainedVoiceRecording, saveRetainedVoice, subscribeRetainedVoice, voiceScopeKey, type RetainedVoiceRecording } from './retained-recordings'
import { useDesktopVoiceRecorder, type DesktopVoiceRecordingTake } from './useDesktopVoiceRecorder'
import { buildDesktopVoiceMessage } from './voice'

type View = {
    status: DesktopVoiceLifecycle
    take: DesktopVoiceRecordingTake | null
    draft: DesktopVoiceDraft | null
    transcript: string
    error: string | null
    attemptId: string | null
}
const initialView: View = { status: 'idle', take: null, draft: null, transcript: '', error: null, attemptId: null }
const busy = (status: DesktopVoiceLifecycle) => ['starting', 'recording', 'uploading', 'transcribing', 'sending'].includes(status)
function restoredStatus(draft: DesktopVoiceDraft): DesktopVoiceLifecycle {
    return ['ready', 'sent', 'failed', 'unavailable'].includes(draft.phase) ? draft.phase : 'review'
}
function fromDraft(draft: DesktopVoiceDraft): View {
    return { take: null, draft, attemptId: draft.attemptId, transcript: draft.transcript ?? '', status: restoredStatus(draft), error: draft.error }
}
function fromRetained(record: RetainedVoiceRecording): View {
    return record.draft ? fromDraft(record.draft) : { take: record.take, draft: null, attemptId: record.attemptId, transcript: '', status: record.pending ? 'uploading' : 'failed', error: record.error }
}

type Capture = { scope: DesktopVoiceScope; key: string; token: number }
export function useDesktopVoiceMessage({ agentId, tabUid, sessionId, enabled = true, active = true, modelChoice, onSent }: DesktopVoiceScope & {
    enabled?: boolean
    active?: boolean
    modelChoice?: DesktopVoiceRevisionAction['modelChoice']
    onSent?: (result: DesktopVoiceSendReceipt & { text: string }) => void
}) {
    const scope = useMemo(() => ({ agentId, tabUid, sessionId }), [agentId, tabUid, sessionId])
    const scopeKey = voiceScopeKey(scope)
    const enabledRef = useRef(enabled && active)
    enabledRef.current = enabled && active
    const [view, setView] = useState<View>(initialView)
    const viewRef = useRef(view)
    const latestScopeKey = useRef(scopeKey)
    latestScopeKey.current = scopeKey
    const mounted = useRef(true)
    const generation = useRef(0)
    const operation = useRef<AbortController | null>(null)
    const capture = useRef<Capture | null>(null)
    const finishing = useRef<Promise<void> | null>(null)
    const raw = useRef<RetainedVoiceRecording | null>(null)
    const modelChoiceRef = useRef(modelChoice)
    modelChoiceRef.current = modelChoice
    const sendAttempt = useRef<{ key: string; attemptId: string; modelChoice: DesktopVoiceRevisionAction['modelChoice'] } | null>(null)
    const onSentRef = useRef(onSent)
    onSentRef.current = onSent
    const finishRef = useRef<() => Promise<void>>(async () => {})
    const stopRef = useRef<() => void>(() => {})
    const current = useCallback((key: string, token: number) => mounted.current && latestScopeKey.current === key && generation.current === token, [])
    const publish = useCallback((next: View) => { viewRef.current = next; if (mounted.current) setView(next) }, [])
    const cancelOperation = useCallback(() => { generation.current++; operation.current?.abort(); operation.current = null }, [])

    const recorder = useDesktopVoiceRecorder({
        onError: error => {
            const owner = capture.current
            if (owner ? current(owner.key, owner.token) : mounted.current && latestScopeKey.current === scopeKey) publish({ ...viewRef.current, status: 'failed', error })
        },
        onLimitReached: () => { void finishRef.current() },
        onDispose: () => {
            if (finishing.current) return true
            if (capture.current && viewRef.current.status === 'recording') { void finishRef.current(); return true }
            return false
        },
    })

    const finish = useCallback((): Promise<void> => {
        if (finishing.current) return finishing.current
        const owner = capture.current
        if (!owner || viewRef.current.status !== 'recording') return Promise.resolve()
        capture.current = null
        const retained = retainVoiceRecording(owner.scope, recorder.stop)
        if (current(owner.key, owner.token)) { raw.current = retained; publish(fromRetained(retained)) }
        const work = saveRetainedVoice(retained).then(() => {
            if (current(owner.key, owner.token)) {
                if (!retained.draft && !retained.pending && retainedVoiceRecording(retained.scope) !== retained) raw.current = null
                publish(fromRetained(retained))
            }
        }).finally(() => { if (finishing.current === work) finishing.current = null })
        finishing.current = work
        return work
    }, [current, publish, recorder.stop])
    finishRef.current = finish

    const stopCapture = useCallback(() => {
        if (viewRef.current.status === 'recording') { void finishRef.current(); return }
        if (viewRef.current.status === 'starting') {
            capture.current = null
            cancelOperation()
            void recorder.cancel()
            publish(initialView)
        }
    }, [cancelOperation, publish, recorder.cancel])
    stopRef.current = stopCapture

    const start = useCallback(async () => {
        if (!enabledRef.current || finishing.current || retainedVoiceRecording(scope) || isDesktopQuitting() || document.visibilityState !== 'visible' || raw.current && !raw.current.draft || viewRef.current.draft || busy(viewRef.current.status)) return
        if (!canRetainVoiceRecording()) { publish({ ...initialView, status: 'failed', error: 'Save or discard another pending voice recording before recording again.' }); return }
        cancelOperation()
        const owner = { scope: { ...scope }, key: scopeKey, token: generation.current }
        capture.current = owner
        publish({ ...initialView, status: 'starting' })
        const started = await recorder.start()
        const hidden = () => document.visibilityState !== 'visible'
        if (!current(owner.key, owner.token) || !enabledRef.current || isDesktopQuitting() || hidden()) {
            if (capture.current === owner) capture.current = null
            if (started) await recorder.cancel()
            return
        }
        if (started) publish({ ...initialView, status: 'recording' })
        else capture.current = null
    }, [cancelOperation, current, publish, recorder.start, recorder.cancel, scope, scopeKey])

    const reconcile = useCallback(async (attemptId: string, key = scopeKey, token = generation.current) => {
        try {
            const draft = await readDesktopVoiceDraft(scope, attemptId, operation.current?.signal)
            if (current(key, token) && draft) {
                publish(fromDraft(draft))
                return draft
            }
        } catch {}
    }, [current, publish, scope, scopeKey])

    const transcribe = useCallback(async () => {
        const snapshot = viewRef.current
        if (!enabledRef.current || isDesktopQuitting() || busy(snapshot.status) || !snapshot.draft && !raw.current) return
        cancelOperation()
        const key = scopeKey, token = generation.current, controller = new AbortController()
        operation.current = controller
        const release = holdDraftAdmission()
        let acknowledged = snapshot.draft
        try {
            if (!acknowledged && raw.current) {
                const retained = raw.current
                publish({ ...snapshot, status: 'uploading', error: null })
                acknowledged = await saveRetainedVoice(retained)
                if (!current(key, token)) return
                if (!acknowledged) { publish(fromRetained(retained)); return }
            }
            if (!acknowledged || !current(key, token) || !enabledRef.current || isDesktopQuitting()) return
            publish({ ...fromDraft(acknowledged), status: 'transcribing', error: null })
            const next = await transcribeDesktopVoice(acknowledged.scope, acknowledged.attemptId, acknowledged.revision, controller.signal)
            if (current(key, token)) publish(fromDraft(next))
        } catch (error) {
            if (!current(key, token)) return
            publish({ ...snapshot, draft: acknowledged, status: 'failed', error: error instanceof Error ? error.message : 'Transcription failed. Retry the saved recording.' })
            if (acknowledged) await reconcile(acknowledged.attemptId, key, token)
        } finally { if (generation.current === token) operation.current = null; release() }
    }, [cancelOperation, current, publish, reconcile, scope, scopeKey])

    const send = useCallback(async () => {
        const snapshot = viewRef.current, draft = snapshot.draft
        if (!enabledRef.current || isDesktopQuitting() || !draft || !snapshot.transcript.trim() || busy(snapshot.status)) return
        cancelOperation()
        const key = scopeKey, token = generation.current, controller = new AbortController()
        operation.current = controller
        const release = holdDraftAdmission()
        publish({ ...snapshot, status: 'sending', error: null })
        let accepted: (DesktopVoiceSendReceipt & { text: string }) | undefined
        try {
            if (!sendAttempt.current || sendAttempt.current.key !== key || sendAttempt.current.attemptId !== draft.attemptId) {
                const savedChoice = draft.sendModelChoice
                const choice = savedChoice === undefined ? modelChoiceRef.current : savedChoice ?? undefined
                sendAttempt.current = { key, attemptId: draft.attemptId, modelChoice: choice ? { ...choice } : undefined }
            }
            const choice = sendAttempt.current.modelChoice
            const result = choice ? await sendDesktopVoice(draft.scope, draft.attemptId, draft.revision, controller.signal, choice)
                : await sendDesktopVoice(draft.scope, draft.attemptId, draft.revision, controller.signal)
            if (!current(key, token)) return
            if (!result.text) { publish(fromDraft(result.draft)); return }
            raw.current = null
            publish(fromDraft(result.draft))
            accepted = { ...result, text: result.text }
        } catch (error) {
            if (!current(key, token)) return
            publish({ ...snapshot, status: 'failed', error: error instanceof Error ? error.message : 'Voice message acknowledgement is unknown. Retry the same attempt.' })
            const recovered = await reconcile(draft.attemptId, key, token)
            if (current(key, token) && recovered?.phase === 'sent' && recovered.dispatch && recovered.transcript?.trim()) {
                raw.current = null
                accepted = {
                    draft: recovered,
                    dispatch: recovered.dispatch,
                    text: buildDesktopVoiceMessage(recovered.scope, recovered.recording, recovered.transcript),
                }
            }
        } finally { if (generation.current === token) operation.current = null; release() }
        if (accepted && current(key, token)) onSentRef.current?.(accepted)
    }, [cancelOperation, current, publish, reconcile, scope, scopeKey])

    const retry = useCallback(async () => {
        if (viewRef.current.draft?.transcript || viewRef.current.transcript.trim()) await send()
        else if (viewRef.current.draft || raw.current) await transcribe()
        else await start()
    }, [send, start, transcribe])

    const discard = useCallback(async () => {
        const snapshot = viewRef.current
        if (finishing.current || ['uploading', 'transcribing', 'sending'].includes(snapshot.status)) return false
        cancelOperation()
        const key = scopeKey, token = generation.current, controller = new AbortController()
        operation.current = controller
        capture.current = null
        await recorder.cancel()
        if (!current(key, token)) return false
        if (snapshot.draft?.phase === 'sent') { raw.current = null; publish(initialView); return true }
        const release = holdDraftAdmission()
        let draft = snapshot.draft
        try {
            if (!draft && raw.current) {
                draft = await saveRetainedVoice(raw.current)
                if (!current(key, token)) return false
                if (!draft) throw new Error('Save this recording before discarding its exact saved attempt.')
            }
            if (draft) await discardDesktopVoice(draft.scope, draft.attemptId, draft.revision, controller.signal)
            if (!current(key, token)) return false
            raw.current = null
            publish(initialView)
            return true
        } catch (error) {
            if (current(key, token)) publish({ ...snapshot, draft, status: 'failed', error: error instanceof Error ? error.message : 'Could not discard this recording.' })
            return false
        } finally { if (generation.current === token) operation.current = null; release() }
    }, [cancelOperation, current, publish, recorder.cancel, scope, scopeKey])

    const rerecord = useCallback(async () => {
        const key = scopeKey, token = generation.current + 1
        if (await discard() && current(key, token)) await start()
    }, [current, discard, scopeKey, start])

    useEffect(() => {
        mounted.current = true
        const visibility = () => { if (document.visibilityState !== 'visible') stopRef.current() }
        document.addEventListener('visibilitychange', visibility)
        const unsubscribe = subscribeDraftShutdown(() => { if (isDesktopQuitting()) stopRef.current() })
        return () => {
            if (capture.current && viewRef.current.status === 'recording') void finishRef.current()
            mounted.current = false
            cancelOperation()
            if (!finishing.current) void recorder.cancel()
            document.removeEventListener('visibilitychange', visibility)
            unsubscribe()
        }
    }, [cancelOperation, recorder.cancel])

    useEffect(() => { if (!active || !enabled) stopRef.current() }, [active, enabled])

    useEffect(() => {
        if (capture.current && capture.current.key !== scopeKey && viewRef.current.status === 'recording') void finishRef.current()
        cancelOperation()
        if (!finishing.current) void recorder.cancel()
        const retained = retainedVoiceRecording(scope)
        raw.current = retained
        publish(retained ? fromRetained(retained) : initialView)
        const key = scopeKey, token = generation.current, controller = new AbortController()
        const unsubscribe = subscribeRetainedVoice(record => {
            if (!current(key, token) || voiceScopeKey(record.scope) !== key) return
            raw.current = record.draft || record.pending || retainedVoiceRecording(record.scope) === record ? record : null
            publish(fromRetained(record))
        })
        if (!retained) void (async () => {
            try {
                const drafts = await listDesktopVoiceDrafts(scope, controller.signal)
                if (!current(key, token) || raw.current) return
                const draft = drafts.filter(item => item.phase !== 'sent').at(-1) ?? null
                publish(draft ? fromDraft(draft) : initialView)
            } catch (error) {
                if (current(key, token)) publish({ ...initialView, status: 'failed', error: error instanceof Error ? error.message : 'Could not restore the voice draft.' })
            }
        })()
        return () => { controller.abort(); unsubscribe(); cancelOperation() }
    }, [scopeKey, scope, cancelOperation, current, publish, recorder.cancel])

    return { ...view, stream: recorder.stream, getLiveState: recorder.getLiveState, start, finish, transcribe, send, retry, discard, rerecord, reconcile }
}
