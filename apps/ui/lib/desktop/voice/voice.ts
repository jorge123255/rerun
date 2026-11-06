import { appendVoiceMarker, buildVoiceMarker } from '@rerun/contracts'
import type { DesktopVoiceRecording, DesktopVoiceScope } from '@rerun/contracts'

export function desktopVoiceAudioReference(scope: DesktopVoiceScope, attemptId: string): string {
    const query = new URLSearchParams({ tabUid: scope.tabUid, attemptId, view: 'audio' })
    if (scope.sessionId) query.set('sessionId', scope.sessionId)
    return `/api/desktop/coworkers/${encodeURIComponent(scope.agentId)}/voice?${query}`
}

export function isDesktopVoiceAudioReference(scope: DesktopVoiceScope, src: string): boolean {
    if (!src.startsWith('/api/desktop/coworkers/') || src.includes('\\') || src.includes('://')) return false
    try {
        const url = new URL(src, 'http://127.0.0.1')
        const expected = new URL(desktopVoiceAudioReference(scope, url.searchParams.get('attemptId') ?? ''), 'http://127.0.0.1')
        return url.pathname === expected.pathname && url.searchParams.get('attemptId') !== null && url.searchParams.get('tabUid') === scope.tabUid && (url.searchParams.get('sessionId') ?? undefined) === scope.sessionId && url.searchParams.get('view') === 'audio' && url.searchParams.size === expected.searchParams.size
    } catch {
        return false
    }
}

export function desktopVoiceAttemptFingerprint(scope: DesktopVoiceScope, recording: DesktopVoiceRecording): string {
    return JSON.stringify([scope, recording])
}

export function buildDesktopVoiceMessage(scope: DesktopVoiceScope, recording: DesktopVoiceRecording, transcript: string): string {
    return appendVoiceMarker(transcript, buildVoiceMarker({
        src: desktopVoiceAudioReference(scope, recording.attemptId),
        durationMs: recording.durationMs,
        levels: recording.levels,
    }))
}
