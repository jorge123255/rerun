// Waveform of a voice message, small enough to travel inside the message text itself
// (see the marker below). 48 amplitudes, one base36 digit each, so the whole shape
// costs 48 characters and survives a reload without re-decoding the audio.
//
// This lives in contracts because both the web composer and the iOS one record voice messages.

export const PEAK_COUNT = 48

export const MAX_RECORDING_MS = 5 * 60 * 1000

const MAX_LEVEL = 35 // 'z', the last base36 digit

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0
    return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Downsamples the levels captured while recording to PEAK_COUNT base36 digits. */
export function encodePeaks(levels: readonly number[]): string {
    if (levels.length === 0) return ''
    let encoded = ''
    for (let i = 0; i < PEAK_COUNT; i++) {
        const start = Math.floor((i * levels.length) / PEAK_COUNT)
        const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / PEAK_COUNT))
        let sum = 0
        let count = 0
        for (let j = start; j < end && j < levels.length; j++) {
            sum += clamp01(levels[j])
            count++
        }
        encoded += Math.round((count > 0 ? sum / count : 0) * MAX_LEVEL).toString(36)
    }
    return encoded
}

/** Inverse of encodePeaks. Unknown characters read as silence rather than breaking the bubble. */
export function decodePeaks(encoded: string): number[] {
    const peaks: number[] = []
    for (const char of encoded) {
        const value = Number.parseInt(char, 36)
        peaks.push(Number.isNaN(value) ? 0 : clamp01(value / MAX_LEVEL))
    }
    return peaks
}

export type VoiceMessage = {
    transcript: string
    src: string
    durationMs: number
    peaks: number[]
}

// A voice message reaches the agent as its transcript, but the bubble has to show the audio,
// and the engine only ever stores the message text (no per-message metadata column). So the
// audio travels as a marker appended to the text, the same trick the engine uses for
// <trigger_payload> (see lib/triggers/trigger-payload.ts). Attribute values are quoted with
// their inner quotes escaped, so a value carrying a `>` cannot end the tag early.
const BLOCK = /\n*<voice ((?:[^>"]|"[^"]*")*)>\s*$/
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g

function escapeAttribute(value: string): string {
    return value.replaceAll('"', '&quot;')
}

export function buildVoiceMarker({ src, durationMs, levels }: { src: string; durationMs: number; levels: readonly number[] }): string {
    return `<voice src="${escapeAttribute(src)}" ms="${Math.max(0, Math.round(durationMs))}" peaks="${encodePeaks(levels)}">`
}

export function appendVoiceMarker(transcript: string, marker: string): string {
    const trimmed = transcript.trim()
    return trimmed ? `${trimmed}\n\n${marker}` : marker
}

/** The message text without its voice marker, for anything that shows a preview (session titles). */
export function stripVoiceMarker(text: string): string {
    return text.replace(BLOCK, '').trim()
}

export function parseVoiceMessage(text: string): VoiceMessage | null {
    const match = BLOCK.exec(text)
    if (!match) return null

    const attributes = new Map<string, string>()
    for (const [, name, value] of match[1].matchAll(ATTRIBUTE)) {
        attributes.set(name, value.replaceAll('&quot;', '"'))
    }

    const src = attributes.get('src')
    if (!src) return null

    return {
        transcript: text.slice(0, match.index).trim(),
        src,
        durationMs: Number(attributes.get('ms') ?? 0) || 0,
        peaks: decodePeaks(attributes.get('peaks') ?? ''),
    }
}

/** Real provider/alignment output, supplied from saved artifact metadata, never estimated by text length. */
export type VoiceTranscriptAlignment = {
    version: 1
    source: 'provider' | 'alignment'
    provenance: string
    transcript: string
    durationMs: number
    words: readonly { text: string; startMs: number; endMs: number }[]
}
export type AlignedTranscriptWord = { text: string; startMs: number | null; endMs: number | null }

/** Missing, inconsistent or incomplete metadata yields the original plain transcript fallback. */
export function alignedTranscriptWords(transcript: string, durationMs: number, alignment?: VoiceTranscriptAlignment | null): AlignedTranscriptWord[] | null {
    if (!alignment || alignment.version !== 1 || !['provider', 'alignment'].includes(alignment.source)
        || typeof alignment.provenance !== 'string' || !alignment.provenance.trim() || alignment.provenance.length > 200
        || transcript.length > 20_000 || alignment.transcript !== transcript || alignment.durationMs !== durationMs
        || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_RECORDING_MS
        || !Array.isArray(alignment.words) || !alignment.words.length || alignment.words.length > 5000) return null
    const pieces: AlignedTranscriptWord[] = []
    let offset = 0, previousEnd = 0
    const boundary = (index: number) => index === 0 || index === transcript.length
        || !(transcript.charCodeAt(index) >= 0xdc00 && transcript.charCodeAt(index) <= 0xdfff && transcript.charCodeAt(index - 1) >= 0xd800 && transcript.charCodeAt(index - 1) <= 0xdbff)
    for (const word of alignment.words) {
        if (!word || typeof word.text !== 'string' || !word.text.trim() || word.text.length > 2000
            || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < previousEnd
            || word.startMs < 0 || word.endMs <= word.startMs || word.endMs > durationMs) return null
        const start = transcript.indexOf(word.text, offset), end = start + word.text.length
        if (start < offset || !boundary(start) || !boundary(end) || !/^[\s\p{P}]*$/u.test(transcript.slice(offset, start))) return null
        if (start > offset) pieces.push({ text: transcript.slice(offset, start), startMs: null, endMs: null })
        pieces.push({ text: word.text, startMs: word.startMs, endMs: word.endMs })
        offset = end; previousEnd = word.endMs
    }
    if (!/^[\s\p{P}]*$/u.test(transcript.slice(offset))) return null
    if (offset < transcript.length) pieces.push({ text: transcript.slice(offset), startMs: null, endMs: null })
    return pieces
}
