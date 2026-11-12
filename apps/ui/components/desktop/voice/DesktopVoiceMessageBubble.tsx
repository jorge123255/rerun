'use client'

import { BorderBeam } from '@rerun/ui'
import { PauseIcon, Play } from '@/lib/icons'
import { formatVoiceDuration } from '@/lib/voice/duration'
import { PEAK_COUNT } from '@rerun/contracts'
import { Spinner } from '@/components/ui/spinner'
import { useRef, useState, type ReactNode } from 'react'
import type { DesktopVoiceScope } from '@rerun/contracts'
import { useDesktopVoicePlayback } from '@/lib/desktop/voice/useDesktopVoicePlayback'
import { isDesktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { interactionKey, type ChatInteractionIdentity } from '@/lib/desktop/chat-interactions/identity'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { DesktopVoiceTranscriptActions } from '../chat/interactions/DesktopVoiceTranscriptActions'
import { DesktopVoiceWaveform } from './DesktopVoiceWaveform'

export function DesktopVoiceMessageBubble({ scope, src, durationMs, peaks, transcript, identity, active = true, renderPlayer }: {
    scope: DesktopVoiceScope
    src: string
    durationMs: number
    peaks: number[]
    transcript: string
    identity?: ChatInteractionIdentity
    active?: boolean
    renderPlayer?: (player: ReactNode) => ReactNode
}) {
    const root = useRef<HTMLDivElement>(null)
    const [showTranscript, setShowTranscript] = useState(false)
    const valid = isDesktopVoiceAudioReference(scope, src)
    const enabled = active && valid
    const playback = useDesktopVoicePlayback({
        srcUrl: enabled ? src : null,
        ownerKey: identity ? interactionKey(identity) : `${scope.agentId}:${scope.tabUid}:${src}`,
    })
    const current = () => enabled && !isDesktopQuitting() && root.current?.isConnected &&
        !root.current.closest('[hidden],[inert],[data-desktop-tab-active="false"]') ? identity ?? null : null
    const progress = durationMs > 0 ? Math.min(1, playback.elapsedMs / durationMs) : 0
    const levels = peaks.length > 0 ? peaks : Array.from({ length: PEAK_COUNT }, () => 0.25)

    const player = <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
            <button type="button" onClick={() => void playback.toggle()} disabled={!enabled || playback.loading} aria-label={playback.playing ? 'Pause' : 'Play voice message'} className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground transition-colors hover:bg-foreground/20 disabled:opacity-50 in-data-ink:bg-white/15 in-data-ink:text-white in-data-ink:hover:bg-white/25">
                {playback.loading ? <Spinner /> : playback.playing ? <PauseIcon className="size-4" /> : <Play className="size-4" />}
                {playback.playing && <BorderBeam animated pattern="arcs" tone="neutral" width={1} duration={3} />}
            </button>
            <button type="button" onClick={event => playback.seek(event, durationMs)} disabled={!enabled} aria-label="Seek" className="flex w-32 shrink-0 cursor-pointer items-center text-foreground in-data-ink:text-white sm:w-40"><DesktopVoiceWaveform peaks={levels} progress={progress} /></button>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground in-data-ink:text-white/70">{formatVoiceDuration(playback.playing || playback.elapsedMs > 0 ? playback.elapsedMs : durationMs)}</span>
            {!identity && transcript && <button type="button" disabled={!active} className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={showTranscript} onClick={() => setShowTranscript(current => !current)}>{showTranscript ? 'Hide transcript' : 'Show transcript'}</button>}
            <audio ref={playback.audioRef} preload="none" className="hidden" {...playback.audioProps} />
        </div>
        {(playback.error || !valid) && <p role="alert" className="text-xs text-destructive">{valid ? playback.error : 'This recording reference is unavailable.'}</p>}
        {!identity && showTranscript && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{transcript}</p>}
    </div>
    return <div ref={root} className="flex min-w-0 flex-col gap-1.5">
        {renderPlayer ? renderPlayer(player) : player}
        {identity && valid && <DesktopVoiceTranscriptActions identity={identity} current={current}
            voice={{ src, transcript, durationMs, peaks }} active={enabled} elapsedMs={playback.elapsedMs} playing={playback.playing} />}
    </div>
}
