'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopVoiceDraft, DesktopVoiceLifecycle, DesktopVoiceScope } from '../../../../../packages/contracts/src/desktop-voice.ts'
import {
    discardDesktopVoice,
    listDesktopVoiceDrafts,
    readDesktopVoiceDraft,
    sendDesktopVoice,
    transcribeDesktopVoice,
    uploadDesktopVoice,
} from './client'
import { useDesktopVoiceRecorder, type DesktopVoiceRecordingTake } from './useDesktopVoiceRecorder'

type View = {
    status: DesktopVoiceLifecycle
    take: DesktopVoiceRecordingTake | null
    draft: DesktopVoiceDraft | null
    transcript: string
    error: string | null
}

const initialView: View = { status: 'idle', take: null, draft: null, transcript: '', error: null }

function restoredStatus(draft: DesktopVoiceDraft): DesktopVoiceLifecycle {
    if (draft.phase === 'ready') return 'ready'
    if (draft.phase === 'sent') return 'sent'
    if (draft.phase === 'failed') return 'failed'
    if (draft.phase === 'unavailable') return 'unavailable'
    return 'review'
}

export function useDesktopVoiceMessage({ agentId, tabUid, sessionId, onSent }: DesktopVoiceScope & {
    onSent?: (result: { draft: DesktopVoiceDraft; text: string }) => void
}) {
    const scope = { agentId, tabUid, sessionId }
    const scopeKey = JSON.stringify(scope)
    const [view, setView] = useState<View>(initialView)
    const viewRef = useRef(view)
    viewRef.current = view
    const latestScopeKey = useRef(scopeKey)
    latestScopeKey.current = scopeKey
    const mounted = useRef(true)
    const generation = useRef(0)
    const operation = useRef<AbortController | null>(null)
    const onSentRef = useRef(onSent)
    onSentRef.current = onSent
    const finishRef = useRef<() => void>(() => {})

    const publish = useCallback((next: View) => {
        if (mounted.current) setView(next)
    }, [])

    const cancelOperation = useCallback(() => {
        generation.current++
        operation.current?.abort()
        operation.current = null
    }, [])

    const current = useCallback((key: string, token: number) => mounted.current && scopeKey === key && generation.current === token, [scopeKey])

    const reconcile = useCallback(async (attemptId: string, key = scopeKey, token = generation.current) => {
        try {
            const draft = await readDesktopVoiceDraft(scope, attemptId, operation.current?.signal)
            if (!current(key, token) || !draft) return
            publish({ take: viewRef.current.take, draft, transcript: draft.transcript ?? '', status: restoredStatus(draft), error: draft.error })
        } catch { /* The visible retry retains the last acknowledged draft. */ }
    }, [current, publish, scope, scopeKey])

    const recorder = useDesktopVoiceRecorder({
        onError: error => {
            if (latestScopeKey.current === scopeKey) publish({ ...viewRef.current, status: 'failed', error })
        },
        onLimitReached: () => finishRef.current(),
    })

    const start = useCallback(async () => {
        if (viewRef.current.draft || viewRef.current.take || ['recording', 'starting', 'uploading', 'transcribing', 'sending'].includes(viewRef.current.status)) return
        cancelOperation()
        const key = scopeKey
        const token = generation.current
        publish({ ...initialView, status: 'starting' })
        const started = await recorder.start()
        if (!current(key, token)) {
            if (started) recorder.cancel()
            return
        }
        if (started) publish({ ...initialView, status: 'recording' })
    }, [cancelOperation, current, recorder, scopeKey])

    const finish = useCallback(async () => {
        if (viewRef.current.status !== 'recording') return
        const key = scopeKey
        const token = generation.current
        publish({ ...viewRef.current, status: 'review', error: null })
        const take = await recorder.stop()
        if (!current(key, token)) return
        if (!take) publish({ ...initialView, status: 'failed', error: 'Nothing was recorded.' })
        else publish({ status: 'review', take, draft: null, transcript: '', error: null })
    }, [current, publish, recorder, scopeKey])
    finishRef.current = () => { void finish() }

    const transcribe = useCallback(async () => {
        const snapshot = viewRef.current
        const take = snapshot.take
        const existing = snapshot.draft
        if (!take && !existing) return
        cancelOperation()
        const key = scopeKey
        const token = generation.current
        const controller = new AbortController()
        operation.current = controller
        const attemptId = existing?.attemptId ?? crypto.randomUUID()
        try {
            let draft = existing
            if (take) {
                publish({ ...snapshot, status: 'uploading', error: null })
                draft = await uploadDesktopVoice(scope, attemptId, take, controller.signal)
                if (!current(key, token)) return
            }
            publish({ take, draft: draft!, transcript: '', status: 'transcribing', error: null })
            draft = await transcribeDesktopVoice(scope, attemptId, draft!.revision, controller.signal)
            if (!current(key, token)) return
            publish({ take, draft, transcript: draft.transcript ?? '', status: restoredStatus(draft), error: draft.error })
        } catch (error) {
            if (!current(key, token)) return
            publish({ take, draft: existing, transcript: existing?.transcript ?? '', status: 'failed', error: error instanceof Error ? error.message : 'Transcription failed. Retry the saved recording.' })
            await reconcile(attemptId, key, token)
        } finally {
            if (generation.current === token) operation.current = null
        }
    }, [cancelOperation, current, publish, reconcile, scope, scopeKey])

    const send = useCallback(async () => {
        const snapshot = viewRef.current
        const draft = snapshot.draft
        if (!draft || !snapshot.transcript.trim()) return
        cancelOperation()
        const key = scopeKey
        const token = generation.current
        const controller = new AbortController()
        operation.current = controller
        publish({ ...snapshot, status: 'sending', error: null })
        try {
            const result = await sendDesktopVoice(scope, draft.attemptId, draft.revision, controller.signal)
            if (!current(key, token)) return
            if (!result.text) {
                publish({ ...snapshot, draft: result.draft, status: 'review', error: result.draft.error })
                return
            }
            publish({ take: null, draft: result.draft, transcript: result.draft.transcript ?? '', status: 'sent', error: null })
            onSentRef.current?.({ draft: result.draft, text: result.text })
        } catch (error) {
            if (!current(key, token)) return
            publish({ ...snapshot, status: 'failed', error: error instanceof Error ? error.message : 'Voice message acknowledgement is unknown. Retry the same attempt.' })
            await reconcile(draft.attemptId, key, token)
        } finally {
            if (generation.current === token) operation.current = null
        }
    }, [cancelOperation, current, publish, reconcile, scope, scopeKey])

    const retry = useCallback(async () => {
        if (!viewRef.current.take && !viewRef.current.draft) await start()
        else if (viewRef.current.draft?.transcript || viewRef.current.transcript.trim()) await send()
        else await transcribe()
    }, [send, start, transcribe])

    const discard = useCallback(async () => {
        const snapshot = viewRef.current
        cancelOperation()
        recorder.cancel()
        const key = scopeKey
        const token = generation.current
        const draft = snapshot.draft
        if (draft) {
            try {
                await discardDesktopVoice(scope, draft.attemptId, draft.revision)
            } catch (error) {
                publish({ ...snapshot, status: 'failed', error: error instanceof Error ? error.message : 'This recording is still referenced and cannot be discarded.' })
                return false
            }
        }
        if (!current(key, token)) return false
        publish(initialView)
        return true
    }, [cancelOperation, current, publish, recorder, scope, scopeKey])

    const rerecord = useCallback(async () => {
        if (await discard()) await start()
    }, [discard, start])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            cancelOperation()
            recorder.cancel()
        }
    }, [cancelOperation, recorder.cancel])

    useEffect(() => {
        cancelOperation()
        recorder.cancel()
        publish(initialView)
        const key = scopeKey
        const token = generation.current
        void (async () => {
            try {
                const drafts = await listDesktopVoiceDrafts(scope)
                if (!current(key, token)) return
                const draft = drafts.at(-1) ?? null
                publish({ take: null, draft, transcript: draft?.transcript ?? '', status: draft ? restoredStatus(draft) : 'idle', error: draft?.error ?? null })
            } catch (error) {
                if (current(key, token)) publish({ ...initialView, status: 'failed', error: error instanceof Error ? error.message : 'Could not restore the voice draft.' })
            }
        })()
        return cancelOperation
    }, [scopeKey])

    return {
        ...view,
        stream: recorder.stream,
        getLiveState: recorder.getLiveState,
        start,
        finish,
        transcribe,
        send,
        retry,
        discard,
        rerecord,
        reconcile,
    }
}
