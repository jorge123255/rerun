import { expect, test } from 'vitest'
import { alignedTranscriptWords, type VoiceTranscriptAlignment } from '../../../../../packages/contracts/src/voice'
import { savedVoiceWords } from './voice'
import { interaction } from './fixtures'

export const transcript = 'Café, 👋 世界!'
export const alignment: VoiceTranscriptAlignment = {
    version: 1, source: 'provider', provenance: 'saved-offline-fixture', transcript, durationMs: 2400,
    words: [{ text: 'Café', startMs: 120, endMs: 610 }, { text: '👋', startMs: 900, endMs: 1100 }, { text: '世界', startMs: 1600, endMs: 2190 }],
}
test('genuine alignment preserves Unicode and actual starts, including untimed punctuation', () => {
    const words = alignedTranscriptWords(transcript, 2400, alignment)!
    expect(words.map(w => w.text).join('')).toBe(transcript)
    expect(words.filter(w => w.startMs !== null).map(w => w.startMs)).toEqual([120, 900, 1600])
    expect(words.find(w => w.text === ', ')?.startMs).toBeNull()
})
test('missing, partial, invented or inconsistent timing falls back instead of estimating', () => {
    expect(alignedTranscriptWords(transcript, 2400)).toBeNull()
    for (const invalid of [
        { ...alignment, words: alignment.words.slice(0, 1) },
        { ...alignment, provenance: '' },
        { ...alignment, transcript: 'different' },
        { ...alignment, words: [{ text: 'Café', startMs: 500, endMs: 400 }] },
        { ...alignment, words: [{ text: 'Café', startMs: 0, endMs: 3000 }] },
    ]) expect(alignedTranscriptWords(transcript, 2400, invalid)).toBeNull()
})
test('same text in another message or audio artifact cannot inherit alignment after restore', () => {
    const metadata = { identity: interaction, src: '/saved/audio-one', alignment }
    expect(savedVoiceWords(interaction, metadata.src, transcript, 2400, metadata)).not.toBeNull()
    expect(savedVoiceWords({ ...interaction, messageId: 'other-message' }, metadata.src, transcript, 2400, metadata)).toBeNull()
    expect(savedVoiceWords(interaction, '/saved/audio-two', transcript, 2400, metadata)).toBeNull()
    expect(savedVoiceWords(interaction, metadata.src, transcript, 2400)).toBeNull()
})
