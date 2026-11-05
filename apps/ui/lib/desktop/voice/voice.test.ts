import { parseVoiceMessage } from '@rerun/contracts'
import { describe, expect, it } from 'vitest'
import {
    buildDesktopVoiceMessage,
    desktopVoiceAttemptFingerprint,
    desktopVoiceAudioReference,
    isDesktopVoiceAudioReference,
} from './voice'

const scope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'session-1' }
const recording = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    byteLength: 4,
    mimeType: 'audio/webm;codecs=opus',
    extension: 'webm',
    transcriptionFormat: 'webm',
    durationMs: 1200,
    levels: [0, 0.5, 1],
}

describe('desktop voice identity and marker', () => {
    it('binds attempt fingerprints to exact owner/tab and recording identity', () => {
        expect(desktopVoiceAttemptFingerprint(scope, recording)).toBe(desktopVoiceAttemptFingerprint(scope, recording))
        expect(desktopVoiceAttemptFingerprint({ ...scope, tabUid: 'other' }, recording)).not.toBe(desktopVoiceAttemptFingerprint(scope, recording))
        expect(desktopVoiceAttemptFingerprint(scope, { ...recording, sha256: 'b'.repeat(64) })).not.toBe(desktopVoiceAttemptFingerprint(scope, recording))
    })

    it('uses the original voice marker with an authenticated immutable local reference', () => {
        const text = buildDesktopVoiceMessage(scope, recording, '  Transcript text.  ')
        const parsed = parseVoiceMessage(text)
        expect(parsed).toMatchObject({ transcript: 'Transcript text.', durationMs: 1200, src: desktopVoiceAudioReference(scope, recording.attemptId) })
        expect(parsed?.peaks).toHaveLength(48)
        expect(isDesktopVoiceAudioReference(scope, parsed!.src)).toBe(true)
        expect(isDesktopVoiceAudioReference({ ...scope, agentId: 'other' }, parsed!.src)).toBe(false)
        expect(isDesktopVoiceAudioReference(scope, 'https://example.com/audio')).toBe(false)
        expect(isDesktopVoiceAudioReference(scope, '/api/desktop/coworkers/other/voice?attemptId=other')).toBe(false)
    })
})
