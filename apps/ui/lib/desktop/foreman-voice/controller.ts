import {
    FOREMAN_VOICE_MIN_MS, sameForemanVoiceTarget,
    type ForemanVoiceTarget, type ForemanVoiceSnapshot, type ForemanVoiceAccepted,
} from '../../../../../packages/contracts/src/desktop-foreman-voice'
import type { DesktopVoiceRecordingTake } from '../voice/useDesktopVoiceRecorder'
import type { ForemanAudioJournal, PendingAudio } from './journal'
import { audioBase64, type createForemanVoiceClient } from './client'

export type ForemanVoicePhase = 'idle' | 'restoring' | 'starting' | 'listening' | 'saving' | 'transcribing' | 'review' | 'sending' | 'sent' | 'error'
export type ForemanVoiceView = { phase: ForemanVoicePhase; pending: PendingAudio | null; snapshot: ForemanVoiceSnapshot | null; error: string | null; restored: boolean }
export type ForemanRecorder = { start(): Promise<boolean>; stop(): Promise<DesktopVoiceRecordingTake | null>; cancel(): Promise<unknown> }
export function createForemanVoiceController(target: ForemanVoiceTarget, ports: {
    recorder: ForemanRecorder; journal: ForemanAudioJournal; client: ReturnType<typeof createForemanVoiceClient>
    uuid(): string; current(): boolean; onEngage?(): void; onAccepted?(receipt: ForemanVoiceAccepted): void
    holdWrite?(): () => void; releasePolicy?: 'send' | 'review'
}) {
    let view: ForemanVoiceView = { phase: 'idle', pending: null, snapshot: null, error: null, restored: false }
    let epoch = 0, closed = false, working = false, captureId: string | null = null
    let operation = new AbortController()
    const listeners = new Set<() => void>(), accepted = new Set<string>()
    const publish = (patch: Partial<ForemanVoiceView>) => {
        if (closed) return
        view = { ...view, ...patch }
        for (const f of listeners) f()
    }
    const isCurrent = (e: number) => !closed && epoch === e && ports.current()
    function begin() {
        operation.abort(); operation = new AbortController()
        return { e: ++epoch, signal: operation.signal }
    }
    async function request(action: 'read' | 'transcribe' | 'send' | 'discard', e: number, signal: AbortSignal) {
        const p = view.pending
        if (!p) throw Error('No recording is selected.')
        const draft = view.snapshot?.attempt
        if (action !== 'read' && !draft) throw Error('Refresh this recording before continuing.')
        const result = await ports.client.request(action === 'read'
            ? { action, target, attemptId: p.attemptId }
            : { action, target, attemptId: p.attemptId, expectedRevision: draft!.revision }, signal)
        if (!isCurrent(e)) return null
        publish({ snapshot: result, error: result.attempt?.error ?? null })
        if (result.receipt) {
            publish({ phase: 'sent' })
            if (action === 'send' && !accepted.has(result.receipt.requestId)) {
                accepted.add(result.receipt.requestId)
                ports.onAccepted?.(result.receipt)
            }
        }
        return result
    }
    async function savePending(e: number, signal: AbortSignal) {
        const pending = view.pending
        if (!pending) throw Error('Recording is unavailable.')
        const release = ports.holdWrite?.() ?? (() => {})
        try { await ports.journal.put(pending) } finally { release() }
        if (!isCurrent(e)) return null
        if (!pending.blob) return request('read', e, signal)
        const bytes = await audioBase64(pending.blob)
        if (!isCurrent(e)) return null
        const result = await ports.client.request({ action: 'upload', target, attemptId: pending.attemptId, format: pending.format, durationMs: pending.durationMs, levels: pending.levels, audioBase64: bytes }, signal)
        if (!isCurrent(e)) return null
        publish({ snapshot: result, error: result.attempt?.error ?? null })
        return result
    }
    async function transcribeAndMaybeSend(e: number, signal: AbortSignal, send: boolean) {
        let result = view.snapshot
        if (!result?.attempt) { publish({ phase: 'saving' }); result = await savePending(e, signal) }
        if (!result || !isCurrent(e)) return
        if (result.receipt) { publish({ phase: 'sent' }); return }
        if (!result.attempt?.transcript) { publish({ phase: 'transcribing' }); result = await request('transcribe', e, signal) }
        if (!result || !isCurrent(e)) return
        if (result.receipt) { publish({ phase: 'sent' }); return }
        if (!result.attempt?.transcript) {
            publish({ phase: 'review', error: result.setup ? 'Transcription is not configured on this Mac.' : result.attempt?.error ?? "Couldn't hear anything in that recording." })
            return
        }
        publish({ phase: 'review' })
        if (send) {
            publish({ phase: 'sending' })
            const sent = await request('send', e, signal)
            if (sent && isCurrent(e) && !sent.receipt) publish({ phase: 'review', error: 'Send acknowledgement is unknown. Refresh this same attempt.' })
        }
    }
    async function act(work: (e: number, signal: AbortSignal) => Promise<void>) {
        if (working || closed || !ports.current()) return
        working = true
        const { e, signal } = begin()
        try { await work(e, signal) } catch {
            if (isCurrent(e)) publish({ phase: 'error', error: 'Voice acknowledgement unavailable. Keep this view open; Refresh or retry Save recording.' })
        } finally { if (epoch === e) working = false }
    }
    return {
        target, getSnapshot: () => view,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        async restore() {
            if (working || view.pending || closed || !ports.current()) return
            working = true
            const { e, signal } = begin()
            publish({ phase: 'restoring' })
            try {
                const pending = await ports.journal.read(target)
                if (!isCurrent(e)) return
                if (!pending) { publish({ phase: 'idle', restored: true }); return }
                if (!sameForemanVoiceTarget(target, pending.target)) throw Error('Recording owner changed.')
                publish({ pending, phase: 'review', restored: true })
                const result = await request('read', e, signal)
                if (result && !result.receipt) publish({ phase: 'review' })
            } catch { if (isCurrent(e)) publish({ phase: 'error', error: 'Saved recording status unavailable. Try again to restore it.' }) }
            finally { if (epoch === e) working = false }
        },
        async start() {
            if (closed || working || view.pending || captureId || !view.restored || !ports.current()) return
            const { e } = begin(); captureId = ports.uuid()
            publish({ phase: 'starting', snapshot: null, error: null })
            ports.onEngage?.()
            const started = await ports.recorder.start()
            if (!isCurrent(e) || !captureId) { if (started) await ports.recorder.cancel(); return }
            if (started) publish({ phase: 'listening' })
            else { captureId = null; if (view.phase !== 'error') publish({ phase: 'error', error: 'Microphone unavailable. Check browser permission and try again.' }) }
        },
        async release(review = false) {
            if (!captureId || working || closed) return
            const id = captureId; captureId = null
            await act(async (e, signal) => {
                const take = await ports.recorder.stop()
                if (!isCurrent(e)) return
                if (!take && view.phase === 'error') return
                if (!take || take.durationMs < FOREMAN_VOICE_MIN_MS) { publish({ phase: 'idle', error: take ? "Couldn't hear anything in that recording." : null }); return }
                publish({ phase: 'saving', pending: { target, attemptId: id, blob: take.blob, format: { mimeType: take.format.mimeType, extension: take.format.extension as 'm4a' | 'webm' | 'ogg', transcriptionFormat: take.format.transcriptionFormat as 'm4a' | 'webm' | 'ogg' }, durationMs: take.durationMs, levels: take.levels } })
                await savePending(e, signal)
                if (isCurrent(e)) {
                    if (review || ports.releasePolicy === 'review') publish({ phase: 'review' })
                    else await transcribeAndMaybeSend(e, signal, true)
                }
            })
        },
        transcribe: () => act((e, s) => transcribeAndMaybeSend(e, s, false)),
        send: () => act((e, s) => transcribeAndMaybeSend(e, s, true)),
        refresh: () => act(async (e, s) => { const result = await request('read', e, s); if (result && !result.receipt) publish({ phase: 'review' }) }),
        retrySave: () => act(async (e, s) => { const result = await savePending(e, s); if (result) publish({ phase: result.receipt ? 'sent' : 'review' }) }),
        done: () => act(async e => {
            const p = view.pending
            if (!p || !view.snapshot?.receipt) return
            await ports.journal.clear(p.attemptId)
            if (isCurrent(e)) publish({ phase: 'idle', pending: null, snapshot: null, error: null })
        }),
        discard: () => act(async (e, s) => {
            const p = view.pending
            if (!p) return
            if (!view.snapshot?.attempt) await request('read', e, s)
            if (!isCurrent(e)) return
            if (view.snapshot?.receipt) throw Error('Accepted turns cannot be discarded.')
            if (view.snapshot?.attempt) { await request('discard', e, s); if (!isCurrent(e)) return }
            else await ports.client.request({ action: 'cancel', target, attemptId: p.attemptId }, s)
            if (!isCurrent(e)) return
            await ports.journal.clear(p.attemptId)
            if (isCurrent(e)) publish({ phase: 'idle', pending: null, snapshot: null, error: null })
        }),
        async cancel() {
            if (closed) return
            const p = view.pending, { e } = begin()
            captureId = null; working = true
            try {
                await ports.recorder.cancel()
                if (p) {
                    const snap = await ports.client.request({ action: 'cancel', target, attemptId: p.attemptId }, AbortSignal.timeout(10_000))
                    if (!closed && epoch === e) publish({ snapshot: snap, phase: snap.receipt ? 'sent' : 'review' })
                } else if (!closed && epoch === e) publish({ phase: 'idle' })
            } catch {
                if (!closed && epoch === e) publish({ phase: p ? 'review' : 'error', error: 'Stop acknowledgement unavailable. Refresh before sending.' })
            } finally { if (epoch === e) working = false }
        },
        fail(message: string) { if (ports.current() && ['starting', 'listening'].includes(view.phase)) publish({ phase: 'error', error: message }) },
        async prepareForQuit() {
            // Root combines this durable-write result with its existing quit handshake.
            captureId = null
            const p = view.pending, { e } = begin()
            working = true
            try {
                await ports.recorder.cancel()
                if (p) {
                    await ports.journal.put(p)
                    await ports.client.request({ action: 'cancel', target, attemptId: p.attemptId }, AbortSignal.timeout(10_000))
                }
                return true
            } catch {
                if (!closed && epoch === e) publish({ phase: 'error', error: 'Voice shutdown is not confirmed. Keep this view open and retry.' })
                return false
            } finally { if (epoch === e) working = false }
        },
        async close() {
            captureId = null
            const p = view.pending
            closed = true; ++epoch; operation.abort(); listeners.clear()
            await ports.recorder.cancel()
            if (p) await ports.client.request({ action: 'cancel', target, attemptId: p.attemptId }, AbortSignal.timeout(10_000)).catch(() => {})
        },
    }
}
export type ForemanVoiceController = ReturnType<typeof createForemanVoiceController>
