import { MAX_RECORDING_MS } from '@rerun/contracts'
import { describe, expect, it } from 'vitest'
import { inspectDesktopVoiceBytes } from './bytes'

const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, ...new TextEncoder().encode('webm')])
const format = { mimeType: 'audio/webm;codecs=opus', extension: 'webm', transcriptionFormat: 'webm' }

describe('desktop voice byte validation', () => {
    it('accepts bounded WebM bytes and exact recording metadata', () => {
        expect(inspectDesktopVoiceBytes(format, webm, { durationMs: 1200, levels: [0, 0.5, 1] })).toMatchObject({ mimeType: format.mimeType, byteLength: webm.byteLength })
    })

    it('rejects mismatched magic, empty audio, excess duration and malformed levels', () => {
        expect(() => inspectDesktopVoiceBytes(format, new Uint8Array(), { durationMs: 1, levels: [] })).toThrow()
        expect(() => inspectDesktopVoiceBytes(format, Uint8Array.from([1, 2, 3, 4]), { durationMs: 1, levels: [] })).toThrow()
        expect(() => inspectDesktopVoiceBytes(format, webm, { durationMs: MAX_RECORDING_MS + 1, levels: [] })).toThrow()
        expect(() => inspectDesktopVoiceBytes(format, webm, { durationMs: 1, levels: [Number.NaN] })).toThrow()
        expect(() => inspectDesktopVoiceBytes(format, webm, { durationMs: 1, levels: Array.from({ length: 6001 }, () => 0) })).toThrow()
    })
})
