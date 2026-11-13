'use client'

import { PauseIcon, Play } from '@/lib/icons'
import { formatVoiceDuration } from '@/lib/voice/duration'
import { PEAK_COUNT } from '@rerun/contracts'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import type { DesktopVoiceDraft, DesktopVoiceScope } from '@rerun/contracts'
import type { DesktopVoiceRecordingTake } from '@/lib/desktop/voice/useDesktopVoiceRecorder'
import { useDesktopVoicePlayback } from '@/lib/desktop/voice/useDesktopVoicePlayback'
import { desktopVoiceAudioReference } from '@/lib/desktop/voice/voice'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopVoiceSeek } from './DesktopVoiceWaveform'

export function DesktopVoiceReview({ scope, take, draft, error, active, onOpenTranscriptionSettings }: {
    scope: DesktopVoiceScope
    take: DesktopVoiceRecordingTake | null
    draft: DesktopVoiceDraft | null
    error: string | null
    active: boolean
    onOpenTranscriptionSettings?: () => void
}) {
    const { t } = useDesktopLocale()
    const durationMs = take?.durationMs ?? draft?.recording.durationMs ?? 0
    const levels = take?.levels ?? draft?.recording.levels ?? []
    // An authenticated first-turn recovery can return a draft from before the tab had a session.
    const srcUrl = active && !take && draft ? desktopVoiceAudioReference(draft.scope, draft.attemptId) : null
    const playback = useDesktopVoicePlayback({ srcUrl, blob: active ? take?.blob : null,
        ownerKey: JSON.stringify([scope.agentId, scope.tabUid, scope.sessionId, draft?.attemptId]) })

    return <div className="flex w-full min-w-0 flex-col gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
            <button type="button" onClick={() => void playback.toggle()} disabled={!active || playback.loading || (!take && !draft)} aria-label={t(playback.playing ? 'voicePause' : 'voicePlay')} className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground hover:bg-foreground/20 disabled:opacity-50">
                {playback.loading ? <Spinner /> : playback.playing ? <PauseIcon className="size-4" /> : <Play className="size-4" />}
            </button>
            <DesktopVoiceSeek peaks={levels.length ? levels : Array.from({ length: PEAK_COUNT }, () => 0.25)}
                elapsedMs={playback.elapsedMs} durationMs={durationMs} label={t('voiceSeek')}
                disabled={!active || !playback.loaded} onSeek={playback.seek} className="flex-1 text-foreground sm:max-w-56" />
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatVoiceDuration(playback.playing || playback.elapsedMs > 0 ? playback.elapsedMs : durationMs)}</span>
            <audio ref={playback.audioRef} preload="none" className="hidden" {...playback.audioProps} />
        </div>
        {take?.limited && <p role="alert" className="text-xs text-amber-500">Recording reached the 2 MB limit. This bounded take is ready for review.</p>}
        {draft?.transcript && <div className="max-h-40 overflow-y-auto rounded-md bg-muted/40 px-2.5 py-2 text-xs whitespace-pre-wrap break-words text-foreground/80"><span className="mb-1 block font-medium text-muted-foreground">{t('voiceTranscript')}</span>{draft.transcript}</div>}
        {(error || playback.error) && <p role="alert" className="text-xs text-destructive">{error ?? playback.error}</p>}
        {active && draft?.phase === 'unavailable' && onOpenTranscriptionSettings &&
            <Button type="button" size="sm" variant="outline" className="self-start" onClick={onOpenTranscriptionSettings}>
                {t('setUpTranscription')}
            </Button>}
    </div>
}
