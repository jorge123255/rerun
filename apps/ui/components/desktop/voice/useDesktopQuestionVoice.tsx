'use client'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { QuestionVoice, QuestionVoiceStatus } from '@rerun/ui/chat'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { z } from 'zod'
import { desktopAuxiliarySettingsSchema } from '@/lib/desktop/auxiliary'
import { isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { encodeDesktopVoiceRecording } from '@/lib/desktop/voice/client'
import { useDesktopVoiceRecorder } from '@/lib/desktop/voice/useDesktopVoiceRecorder'
import { DesktopVoiceRecorderBar } from './DesktopVoiceRecorderBar'

type Capture = {
    controller: AbortController
    phase: Exclude<QuestionVoiceStatus, 'idle'>
    deliver: (transcript: string) => void
}
const transcriptSchema = z.object({ transcript: z.string().trim().min(1).max(20_000) })

export type DesktopQuestionVoiceTarget = { sessionId: string } | { chat: DesktopForemanChatRef }

export function useDesktopQuestionVoice(target: DesktopQuestionVoiceTarget | undefined, questionId: string, enabled: boolean) {
    const chat = target && 'chat' in target ? target.chat : undefined
    const { chatId, workspaceId } = chat ?? {}
    const url = chat ? '/api/desktop/foreman/questions/transcribe'
        : target && 'sessionId' in target ? `/api/desktop/sessions/${encodeURIComponent(target.sessionId)}/questions/transcribe` : undefined
    const [status, setStatus] = useState<QuestionVoiceStatus>('idle')
    const [error, setError] = useState<string | null>(null)
    const capture = useRef<Capture | null>(null)
    const available = useRef(enabled)
    available.current = enabled
    const limit = useRef<() => void>(() => {})
    const recorder = useDesktopVoiceRecorder({ onError: setError, onLimitReached: () => limit.current() })
    const invalidate = useCallback(() => {
        capture.current?.controller.abort()
        capture.current = null
        void recorder.cancel()
    }, [recorder.cancel])
    const cancel = useCallback(() => {
        invalidate()
        setStatus('idle')
        setError(null)
    }, [invalidate])

    useLayoutEffect(() => {
        if (!url) return
        setStatus('idle')
        setError(null)
        const visibility = () => { if (document.visibilityState !== 'visible') cancel() }
        document.addEventListener('visibilitychange', visibility)
        const unsubscribe = subscribeDraftShutdown(() => { if (isDesktopQuitting()) cancel() })
        return () => {
            document.removeEventListener('visibilitychange', visibility)
            unsubscribe()
            invalidate()
        }
    }, [url, workspaceId, chatId, questionId, enabled, cancel, invalidate])

    const stillCurrent = (current: Capture) => capture.current === current && available.current &&
        !current.controller.signal.aborted && !isDesktopQuitting() && document.visibilityState === 'visible'

    function start(deliver: Capture['deliver']) {
        if (!url || !enabled || capture.current || isDesktopQuitting() || document.visibilityState !== 'visible') return
        const current: Capture = { controller: new AbortController(), phase: 'starting', deliver }
        capture.current = current
        setStatus('starting')
        setError(null)
        void (async () => {
            try {
                const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(10_000)])
                const response = await fetch('/api/desktop/auxiliary', { signal, cache: 'no-store' })
                if (!response.ok) throw new Error('Could not check voice transcription. Try again.')
                const settings = desktopAuxiliarySettingsSchema.parse(await response.json())
                if (!stillCurrent(current)) return
                if (!settings.some(item => item.purpose === 'transcription' && item.configured)) {
                    throw new Error('Configure voice transcription in Settings to use a voice answer.')
                }
                if (!await recorder.start() || !stillCurrent(current)) return
                current.phase = 'recording'
                setStatus('recording')
            } catch (cause) {
                if (stillCurrent(current)) setError(cause instanceof Error ? cause.message : 'Could not start voice recording.')
            } finally {
                if (capture.current === current && current.phase === 'starting') {
                    capture.current = null
                    setStatus('idle')
                }
            }
        })()
    }

    function finish() {
        const current = capture.current
        if (!url || !current || current.phase !== 'recording' || !stillCurrent(current)) return
        current.phase = 'transcribing'
        setStatus('transcribing')
        void (async () => {
            try {
                const take = await recorder.stop()
                if (!stillCurrent(current)) return
                if (!take) {
                    setError(previous => previous ?? 'Nothing was recorded. Try again.')
                    return
                }
                const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(35_000)])
                const recording = await encodeDesktopVoiceRecording(take, signal)
                signal.throwIfAborted()
                const response = await fetch(url, {
                    method: 'POST', signal, cache: 'no-store', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ ...(chat && { chat }), questionId, ...recording }),
                })
                const body = await response.json().catch(() => null)
                if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not transcribe the answer.')
                const { transcript } = transcriptSchema.parse(body)
                if (stillCurrent(current)) current.deliver(transcript)
            } catch (cause) {
                if (stillCurrent(current)) setError(cause instanceof Error ? cause.message : 'Could not transcribe the answer.')
            } finally {
                if (capture.current === current) {
                    capture.current = null
                    setStatus('idle')
                }
            }
        })()
    }
    limit.current = finish

    const voice: QuestionVoice | undefined = url && enabled ? {
        status, start, finish, discard: cancel,
        render: () => status === 'transcribing'
            ? <span role="status" className="min-w-0 flex-1 text-sm text-muted-foreground">Transcribing…</span>
            : <DesktopVoiceRecorderBar status={status === 'recording' ? 'recording' : 'starting'} stream={recorder.stream} getLiveState={recorder.getLiveState} />,
    } : undefined
    return { voice, error }
}
