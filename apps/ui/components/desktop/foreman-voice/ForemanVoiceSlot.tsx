'use client'
import { useEffect, useState } from 'react'
import { TextShimmer } from '@rerun/ui'
import { Button } from '@/components/ui/button'
import { LiveWaveform } from '@/components/ui/live-waveform'
import { DesktopVoiceWaveform } from '@/components/desktop/voice/DesktopVoiceWaveform'
import { useDesktopVoicePlayback } from '@/lib/desktop/voice/useDesktopVoicePlayback'
import { foremanVoiceAudioUrl } from '@/lib/desktop/foreman-voice/client'
import type { ForemanVoiceSlotController } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
import { formatVoiceDuration } from '@/lib/voice/duration'
import { MicIcon, SquareIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'

/** The microphone is on screen: it stands in for the send button while the composer is empty. */
export function foremanVoiceMicShown(view: Pick<ForemanVoiceSlotController['view'], 'phase'>) {
    return ['idle', 'starting', 'listening'].includes(view.phase)
}
export type ForemanVoiceSlotProps = { voice: ForemanVoiceSlotController; onOpenTranscriptionSettings(): void }
export function ForemanVoiceSlot({ voice, onOpenTranscriptionSettings }: ForemanVoiceSlotProps) {
    const { t } = useDesktopLocale()
    const { controller, view, stream } = voice
    const recording = view.phase === 'starting' || view.phase === 'listening'
    const busy = ['restoring', 'saving', 'transcribing', 'sending'].includes(view.phase)
    // At rest the slot is the microphone alone, where the composer's send button stands.
    const micOnly = view.phase === 'idle' && view.restored && !view.pending && !view.error && view.snapshot?.setup !== 'transcription'
    return <div data-foreman-voice-controls className={cn('flex min-w-0 flex-col gap-2', micOnly ? 'shrink-0' : 'flex-1')}>
        {recording ? <Recording voice={voice} listening={view.phase === 'listening'} stream={stream} />
            : busy ? <TextShimmer className="truncate text-sm">{t(`foreman.voice.${view.phase === 'restoring' ? 'restoring' : view.phase === 'saving' ? 'saving' : view.phase === 'transcribing' ? 'transcribing' : 'sending'}`)}</TextShimmer> : null}
        {view.pending && <Review voice={voice} />}
        {view.error && <p role="alert" className="break-words text-xs text-destructive">{view.error}</p>}
        {view.snapshot?.setup === 'transcription' && <Button type="button" size="sm" variant="outline" onClick={onOpenTranscriptionSettings}>{t('setUpTranscription')}</Button>}
        {!recording && <div className="flex flex-wrap items-center justify-end gap-2">
            {/* A round microphone in the send button's own variant and size, clicked once to record, as upstream
                apps/ui/components/chat/VoiceComposerControls.tsx. Nothing is recorded before that click. */}
            {view.phase === 'idle' && <Button type="button" size="icon-sm" variant="default" data-foreman-voice-mic
                className="order-last shrink-0 rounded-full" title={t('foreman.voice.record')} aria-label={t('foreman.voice.record')}
                disabled={!view.restored || !voice.active || !!view.pending} onClick={() => void controller.start()}><MicIcon aria-hidden="true" className="size-4" /></Button>}
            {view.phase === 'idle' && !view.restored && <Button type="button" size="sm" variant="outline" onClick={() => void controller.restore()}>{t('foreman.voice.restore')}</Button>}
            {view.phase === 'error' && !view.pending && <Button type="button" size="sm" variant="outline" onClick={() => { void controller.cancel().then(() => controller.restore()).then(() => controller.start()) }}>{t('foreman.voice.tryAgain')}</Button>}
            {view.pending && !busy && view.phase !== 'sent' && <>
                <Button type="button" size="sm" variant="outline" onClick={() => void controller.refresh()}>{t('foreman.voice.refresh')}</Button>
                {(!view.snapshot?.attempt || ['uploading', 'failed'].includes(view.snapshot.attempt.phase)) && <Button type="button" size="sm" onClick={() => void controller.retrySave()}>{t('foreman.voice.save')}</Button>}
                <Button type="button" size="sm" variant="outline" onClick={() => void controller.transcribe()}>{t('foreman.voice.transcribe')}</Button>
                <Button type="button" size="sm" disabled={!view.snapshot?.attempt?.transcript} onClick={() => void controller.send()}>{t('foreman.voice.sendVoice')}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void controller.discard()}>{t('foreman.voice.discard')}</Button>
            </>}
            {view.phase !== 'idle' && view.phase !== 'sent' && <Button type="button" size="sm" variant="ghost" onClick={() => void controller.cancel()}>{t('foreman.voice.cancel')}</Button>}
            {view.phase === 'sent' && <><span role="status" className="text-xs text-muted-foreground">{t('foreman.voice.sent')}</span><Button type="button" size="sm" variant="ghost" onClick={() => void controller.done()}>{t('foreman.voice.done')}</Button></>}
        </div>}
    </div>
}
/**
 * While the microphone is open: the live waveform, how long it has run, Cancel (nothing is kept) and
 * Stop (the take goes to review; sending it stays a separate action). Escape cancels as well.
 */
function Recording({ voice, listening, stream }: { voice: ForemanVoiceSlotController; listening: boolean; stream: MediaStream | null }) {
    const { t } = useDesktopLocale()
    const [elapsed, setElapsed] = useState(0)
    useEffect(() => {
        setElapsed(0)
        if (!listening) return
        const started = Date.now()
        const id = setInterval(() => setElapsed(Date.now() - started), 250)
        return () => clearInterval(id)
    }, [listening])
    return <div data-foreman-voice-recording={listening ? 'recording' : 'starting'} className="flex min-w-0 items-center justify-end gap-2">
        <LiveWaveform active={listening && stream !== null} processing={!listening || stream === null} stream={stream ?? undefined} mode="static"
            height={24} barWidth={3} barGap={1} barRadius={1.5} className="hidden w-20 min-w-0 shrink text-foreground sm:block" />
        <span role="status" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {listening ? <>
                <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" />
                <span className="sr-only">{t('foreman.voice.recording')}</span>
                <span data-foreman-voice-timer className="font-mono tabular-nums">{formatVoiceDuration(elapsed)}</span>
            </> : <TextShimmer className="truncate text-xs">{t('foreman.voice.waiting')}</TextShimmer>}
        </span>
        <Button type="button" size="sm" variant="ghost" className="shrink-0" data-foreman-voice-cancel onClick={() => void voice.controller.cancel()}>
            <XIcon aria-hidden="true" className="size-3.5" />{t('foreman.voice.cancel')}
        </Button>
        <Button type="button" size="sm" variant="default" className="shrink-0" data-foreman-voice-stop disabled={!listening}
            title={t('foreman.voice.stopLabel')} aria-label={t('foreman.voice.stopLabel')} onClick={() => void voice.controller.release(true)}>
            <SquareIcon aria-hidden="true" className="size-3.5" />{t('foreman.voice.stop')}
        </Button>
    </div>
}
function Review({ voice }: { voice: ForemanVoiceSlotController }) {
    const { t } = useDesktopLocale()
    const p = voice.view.pending!, a = voice.view.snapshot?.attempt
    const playback = useDesktopVoicePlayback({ srcUrl: foremanVoiceAudioUrl(p.target, p.attemptId), blob: p.blob, ownerKey: JSON.stringify([p.target, p.attemptId]) })
    return <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={playback.loading} onClick={() => void playback.toggle()}>{playback.playing ? t('foreman.voice.pause') : t('foreman.voice.play')}</Button>
            <DesktopVoiceWaveform peaks={a?.recording.levels ?? p.levels} className="min-w-0 flex-1" />
        </div>
        <audio ref={playback.audioRef} preload="none" className="hidden" {...playback.audioProps} />
        {a?.transcript && <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs">{a.transcript}</p>}
        {playback.error && <p role="alert" className="break-words text-xs text-destructive">{playback.error}</p>}
    </div>
}
