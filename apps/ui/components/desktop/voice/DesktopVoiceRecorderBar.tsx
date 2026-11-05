'use client'

import { Shimmer } from '@/components/ai-elements/shimmer'
import { LiveWaveform } from '@/components/ui/live-waveform'
import { formatVoiceDuration } from '@/lib/voice/duration'
import { useEffect, useState } from 'react'
import type { DesktopVoiceLiveState } from '@/lib/desktop/voice/useDesktopVoiceRecorder'

export function DesktopVoiceRecorderBar({ status, stream, getLiveState }: {
    status: 'starting' | 'recording'
    stream: MediaStream | null
    getLiveState: () => DesktopVoiceLiveState
}) {
    const [durationMs, setDurationMs] = useState(0)
    useEffect(() => {
        if (status !== 'recording') return
        const id = setInterval(() => setDurationMs(getLiveState().durationMs), 50)
        return () => clearInterval(id)
    }, [status, getLiveState])

    return <div className="flex min-h-16 w-full items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1"><LiveWaveform active={status === 'recording'} processing={status !== 'recording'} stream={stream ?? undefined} mode="static" height={48} barWidth={3} barGap={1} barRadius={1.5} className="w-full text-foreground" /></div>
        {status === 'recording' ? <div className="flex shrink-0 items-center gap-1.5"><span className="size-1.5 animate-pulse rounded-full bg-destructive" /><span className="font-mono text-xs tabular-nums text-muted-foreground">{formatVoiceDuration(durationMs)}</span></div>
            : <Shimmer as="span" className="shrink-0 text-xs">Waiting for the microphone...</Shimmer>}
    </div>
}
