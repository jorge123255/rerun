'use client'

import { PauseIcon, Play } from '@/lib/icons'
import { formatVoiceDuration } from '@/lib/voice/duration'
import { PEAK_COUNT } from '@rerun/contracts'
import { Spinner } from '@/components/ui/spinner'
import type { DesktopVoiceDraft, DesktopVoiceScope } from '@rerun/contracts'
import type { DesktopVoiceRecordingTake } from '@/lib/desktop/voice/useDesktopVoiceRecorder'
import { useDesktopVoicePlayback } from '@/lib/desktop/voice/useDesktopVoicePlayback'
import { desktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { DesktopVoiceWaveform } from './DesktopVoiceWaveform'

export function DesktopVoiceReview({ scope, take, draft, error }: {
    scope: DesktopVoiceScope
    take: DesktopVoiceRecordingTake | null
    draft: DesktopVoiceDraft | null
    error: string | null
}) {
    const durationMs = take?.durationMs ?? draft?.recording.durationMs ?? 0
    const levels = take?.levels ?? draft?.recording.levels ?? []
    const srcUrl = take ? null : draft ? desktopVoiceAudioReference(scope, draft.attemptId) : null
    const playback = useDesktopVoicePlayback({ srcUrl, blob: take?.blob, ownerKey: `${scope.agentId}:${scope.tabUid}:${draft?.attemptId ?? 'local'}` })
    const progress = durationMs > 0 ? Math.min(1, playback.elapsedMs / durationMs) : 0

    return <div className="flex w-full min-w-0 flex-col gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
            <button type="button" onClick={() => void playback.toggle()} disabled={playback.loading || (!take && !draft)} aria-label={playback.playing ? 'Pause' : 'Play voice message'} className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground hover:bg-foreground/20 disabled:opacity-50">
                {playback.loading ? <Spinner /> : playback.playing ? <PauseIcon className="size-4" /> : <Play className="size-4" />}
            </button>
            <button type="button" onClick={event => playback.seek(event, durationMs)} aria-label="Seek" className="flex min-w-0 flex-1 cursor-pointer items-center text-foreground sm:max-w-56"><DesktopVoiceWaveform peaks={levels.length ? levels : Array.from({ length: PEAK_COUNT }, () => 0.25)} progress={progress} /></button>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatVoiceDuration(playback.playing || playback.elapsedMs > 0 ? playback.elapsedMs : durationMs)}</span>
            <audio ref={playback.audioRef} preload="none" className="hidden" {...playback.audioProps} />
        </div>
        {take?.limited && <p role="alert" className="text-xs text-amber-500">Recording reached the 2 MB limit. This bounded take is ready for review.</p>}
        {draft?.transcript && <div className="max-h-40 overflow-y-auto rounded-md bg-muted/40 px-2.5 py-2 text-xs whitespace-pre-wrap break-words text-foreground/80"><span className="mb-1 block font-medium text-muted-foreground">Transcript</span>{draft.transcript}</div>}
        {(error || playback.error) && <p role="alert" className="text-xs text-destructive">{error ?? playback.error}</p>}
    </div>
}
