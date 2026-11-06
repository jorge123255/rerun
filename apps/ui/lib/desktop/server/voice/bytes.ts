import { createHash } from 'node:crypto'
import { MAX_RECORDING_MS } from '@rerun/contracts'
import { DESKTOP_VOICE_MAX_BYTES, DESKTOP_VOICE_MAX_LEVELS, type DesktopVoiceFormat } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { inspectDesktopAudioBytes } from '../audio-bytes'

const MIME: Record<DesktopVoiceFormat['transcriptionFormat'], readonly string[]> = {
    m4a: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'],
    webm: ['audio/webm;codecs=opus', 'audio/webm'],
    ogg: ['audio/ogg;codecs=opus'],
}

export function inspectDesktopVoiceBytes(format: DesktopVoiceFormat, bytes: Uint8Array, metadata: { durationMs: number; levels: number[] }) {
    if (!MIME[format.transcriptionFormat]?.includes(format.mimeType) || format.extension !== format.transcriptionFormat) throw new DesktopHttpError(400, 'Unsupported voice format.')
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_VOICE_MAX_BYTES) throw new DesktopHttpError(413, 'Voice recordings can be up to 2 MB.')
    if (!Number.isInteger(metadata.durationMs) || metadata.durationMs < 1 || metadata.durationMs > MAX_RECORDING_MS) throw new DesktopHttpError(400, 'Voice duration is invalid.')
    if (!Array.isArray(metadata.levels) || metadata.levels.length > DESKTOP_VOICE_MAX_LEVELS || metadata.levels.some(level => !Number.isFinite(level) || level < 0 || level > 1)) {
        throw new DesktopHttpError(400, 'Voice waveform is invalid.')
    }
    if (format.transcriptionFormat === 'webm') inspectWebm(bytes)
    else inspectDesktopAudioBytes(format.transcriptionFormat, bytes)
    return {
        ...format,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
        durationMs: metadata.durationMs,
        levels: [...metadata.levels],
    }
}

function inspectWebm(bytes: Uint8Array): void {
    if (bytes.byteLength < 12 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) throw new DesktopHttpError(400, 'Voice bytes do not match WebM.')
    const doctype = new TextDecoder().decode(bytes.subarray(4, Math.min(64, bytes.byteLength)))
    if (!doctype.includes('webm')) throw new DesktopHttpError(400, 'Voice bytes do not match WebM.')
}
