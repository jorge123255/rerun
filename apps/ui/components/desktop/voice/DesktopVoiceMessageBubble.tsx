'use client'

import { BorderBeam } from '@rerun/ui'
import { PauseIcon, Play } from '@/lib/icons'
import { formatVoiceDuration } from '@/lib/voice/duration'
import { PEAK_COUNT } from '@rerun/contracts'
import { Spinner } from '@/components/ui/spinner'
import { useState } from 'react'
import type { DesktopVoiceScope } from '@rerun/contracts'
import { useDesktopVoicePlayback } from '@/lib/desktop/voice/useDesktopVoicePlayback'
import { isDesktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { DesktopVoiceWaveform } from './DesktopVoiceWaveform'

export function DesktopVoiceMessageBubble({ scope, src, durationMs, peaks, transcript }: {
    scope: DesktopVoiceScope
    src: string
    durationMs: number
    peaks: number[]
    transcript: string
}) {
    const [showTranscript, setShowTranscript] = useState(false)
    const valid = isDesktopVoiceAudioReference(scope, src)
    const playback = useDesktopVoicePlayback({ srcUrl: valid ? src : null, ownerKey: `${scope.agentId}:${scope.tabUid}:${src}` })
    const progress = durationMs > 0 ? Math.min(1, playback.elapsedMs / durationMs) : 0
    const levels = peaks.length > 0 ? peaks : Array.from({ length: PEAK_COUNT }, () => 0.25)

    return <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
            <button type="button" onClick={() => void playback.toggle()} disabled={!valid || playback.loading} aria-label={playback.playing ? 'Pause' : 'Play voice message'} className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground transition-colors hover:bg-foreground/20 disabled:opacity-50 in-data-ink:bg-white/15 in-data-ink:text-white in-data-ink:hover:bg-white/25">
                {playback.loading ? <Spinner /> : playback.playing ? <PauseIcon className="size-4" /> : <Play className="size-4" />}
                {playback.playing && <BorderBeam animated pattern="arcs" tone="neutral" width={1} duration={3} />}
            </button>
            <button type="button" onClick={event => playback.seek(event, durationMs)} aria-label="Seek" className="flex w-32 shrink-0 cursor-pointer items-center text-foreground in-data-ink:text-white sm:w-40"><DesktopVoiceWaveform peaks={levels} progress={progress} /></button>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground in-data-ink:text-white/70">{formatVoiceDuration(playback.playing || playback.elapsedMs > 0 ? playback.elapsedMs : durationMs)}</span>
            <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-foreground" aria-expanded={showTranscript} onClick={() => setShowTranscript(current => !current)}>{showTranscript ? 'Hide transcript' : 'Show transcript'}</button>
            <audio ref={playback.audioRef} preload="none" className="hidden" {...playback.audioProps} />
        </div>
        {(playback.error || !valid) && <p role="alert" className="text-xs text-destructive">{valid ? playback.error : 'This recording reference is unavailable.'}</p>}
        {showTranscript && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{transcript}</p>}
    </div>
}
