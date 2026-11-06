'use client'
import { useEffect, useRef } from 'react'
import { ForemanPillVoice } from '@/components/foreman/dock/ForemanPillVoice'
import { TextShimmer } from '@rerun/ui'
import { Button } from '@/components/ui/button'
import { DesktopVoiceWaveform } from '@/components/desktop/voice/DesktopVoiceWaveform'
import { useDesktopVoicePlayback } from '@/lib/desktop/voice/useDesktopVoicePlayback'
import { foremanVoiceAudioUrl } from '@/lib/desktop/foreman-voice/client'
import type { ForemanVoiceSlotController } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
import { FOREMAN_VOICE_HOLD_MS } from '../../../../../packages/contracts/src/desktop-foreman-voice'

export type ForemanVoiceSlotProps = { voice: ForemanVoiceSlotController; onOpenTranscriptionSettings(): void }
export function ForemanVoiceSlot({ voice, onOpenTranscriptionSettings }: ForemanVoiceSlotProps) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null), held = useRef(false)
    const clearHold = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
    const { controller, view, stream } = voice
    useEffect(() => {
        if (!voice.active) { if (timer.current) clearTimeout(timer.current); timer.current = null; held.current = false }
        return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; held.current = false }
    }, [controller, voice.active])
    const busy = ['restoring', 'starting', 'saving', 'transcribing', 'sending'].includes(view.phase)
    return <div data-foreman-voice-controls className="flex min-w-0 flex-1 flex-col gap-2">
        {view.phase === 'listening' && voice.releasePolicy === 'send' ? <ForemanPillVoice phase="listening" stream={stream} />
            : view.phase === 'listening' ? <span role="status" className="min-w-0 truncate text-sm text-muted-foreground">Listening · release Space to review</span>
                : view.phase === 'transcribing' ? <ForemanPillVoice phase="transcribing" stream={null} />
                    : busy ? <TextShimmer className="truncate text-sm">{view.phase === 'restoring' ? 'Restoring recording…' : view.phase === 'starting' ? 'Opening microphone…' : view.phase === 'saving' ? 'Saving recording…' : 'Sending…'}</TextShimmer> : null}
        {view.pending && <Review voice={voice} />}
        {view.error && <p role="alert" className="break-words text-xs text-destructive">{view.error}</p>}
        {view.snapshot?.setup === 'transcription' && <Button size="sm" variant="outline" onClick={onOpenTranscriptionSettings}>Set up transcription</Button>}
        <div className="flex flex-wrap gap-2">
            {['idle', 'starting', 'listening'].includes(view.phase) && <Button size="sm" variant="ghost" disabled={!view.restored || !voice.active}
                onPointerDown={event => {
                    if (event.button !== 0 || held.current) return
                    held.current = true
                    event.currentTarget.setPointerCapture(event.pointerId)
                    timer.current = setTimeout(() => { timer.current = null; void controller.start() }, FOREMAN_VOICE_HOLD_MS)
                }}
                onPointerUp={() => {
                    if (!held.current) return
                    held.current = false
                    if (timer.current) clearHold(); else void controller.release()
                }}
                onPointerCancel={() => { held.current = false; clearHold(); void controller.cancel() }}
                onLostPointerCapture={() => { if (held.current) { held.current = false; clearHold(); void controller.cancel() } }}
                aria-label="Hold to talk to Foreman">Hold to talk</Button>}
            {view.phase === 'idle' && !view.restored && <Button size="sm" variant="outline" onClick={() => void controller.restore()}>Restore recording</Button>}
            {view.phase === 'error' && !view.pending && <Button size="sm" variant="outline" onClick={() => { void controller.cancel().then(() => controller.restore()).then(() => controller.start()) }}>Try again</Button>}
            {view.phase === 'listening' && <Button size="sm" variant="outline" onClick={() => void controller.release(true)}>Review</Button>}
            {view.pending && !busy && view.phase !== 'sent' && <>
                <Button size="sm" variant="outline" onClick={() => void controller.refresh()}>Refresh</Button>
                {(!view.snapshot?.attempt || ['uploading', 'failed'].includes(view.snapshot.attempt.phase)) && <Button size="sm" onClick={() => void controller.retrySave()}>Save recording</Button>}
                <Button size="sm" variant="outline" onClick={() => void controller.transcribe()}>Transcribe</Button>
                <Button size="sm" disabled={!view.snapshot?.attempt?.transcript} onClick={() => void controller.send()}>Send voice message</Button>
                <Button size="sm" variant="ghost" onClick={() => void controller.discard()}>Discard</Button>
            </>}
            {view.phase !== 'idle' && view.phase !== 'sent' && <Button size="sm" variant="ghost" onClick={() => void controller.cancel()}>Cancel</Button>}
            {view.phase === 'sent' && <><span role="status" className="text-xs text-muted-foreground">Sent</span><Button size="sm" variant="ghost" onClick={() => void controller.done()}>Done</Button></>}
        </div>
    </div>
}
function Review({ voice }: { voice: ForemanVoiceSlotController }) {
    const p = voice.view.pending!, a = voice.view.snapshot?.attempt
    const playback = useDesktopVoicePlayback({ srcUrl: foremanVoiceAudioUrl(p.target, p.attemptId), blob: p.blob, ownerKey: JSON.stringify([p.target, p.attemptId]) })
    return <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center gap-2">
            <Button size="sm" variant="ghost" disabled={playback.loading} onClick={() => void playback.toggle()}>{playback.playing ? 'Pause' : 'Play voice message'}</Button>
            <DesktopVoiceWaveform peaks={a?.recording.levels ?? p.levels} className="min-w-0 flex-1" />
        </div>
        <audio ref={playback.audioRef} preload="none" className="hidden" {...playback.audioProps} />
        {a?.transcript && <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs">{a.transcript}</p>}
        {playback.error && <p role="alert" className="text-xs text-destructive">{playback.error}</p>}
    </div>
}
