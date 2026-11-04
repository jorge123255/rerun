import { expect, test } from 'vitest'
import { DesktopAudioBytesError, inspectDesktopAudioBytes } from './audio-bytes'

function u16(value: number) {
    return Buffer.from([value & 255, (value >> 8) & 255])
}
function u32(value: number) {
    return Buffer.from([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255])
}
function wav(format = 1) {
    const fmt = Buffer.concat([u16(format), u16(1), u32(8000), u32(8000), u16(1), u16(8)])
    const chunks = Buffer.concat([Buffer.from('fmt '), u32(fmt.length), fmt, Buffer.from('data'), u32(2), Buffer.from([0x80, 0x80])])
    return Buffer.concat([Buffer.from('RIFF'), u32(4 + chunks.length), Buffer.from('WAVE'), chunks])
}
function mp3Frame() {
    const frame = Buffer.alloc(417)
    frame.set([0xff, 0xfb, 0x90, 0xc0])
    return frame
}

function reason(kind: 'wav' | 'mp3', bytes: Uint8Array) {
    try { inspectDesktopAudioBytes(kind, bytes) }
    catch (error) { return error instanceof DesktopAudioBytesError ? error.reason : 'other' }
    return 'ok'
}

test('accepts a PCM WAV and a Layer III MP3, including an ID3v2 tag', () => {
    expect(inspectDesktopAudioBytes('wav', wav())).toEqual({ contentType: 'audio/wav' })
    const frame = mp3Frame()
    expect(inspectDesktopAudioBytes('mp3', frame)).toEqual({ contentType: 'audio/mpeg' })
    const tagged = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), frame])
    expect(inspectDesktopAudioBytes('mp3', tagged)).toEqual({ contentType: 'audio/mpeg' })
    const footer = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(10), frame])
    expect(inspectDesktopAudioBytes('mp3', footer)).toEqual({ contentType: 'audio/mpeg' })
})

test('refuses the wrong container, a truncated WAV, ADPCM, and a non-MP3 layer', () => {
    expect(reason('wav', Buffer.from('<!doctype html><script>alert(1)</script>'))).toBe('mismatch')
    expect(reason('mp3', wav())).toBe('mismatch')
    expect(reason('wav', wav().subarray(0, wav().length - 1))).toBe('corrupt')
    expect(reason('wav', wav(2))).toBe('unsupported')
    const layer2 = mp3Frame()
    layer2[1] = 0xfd
    expect(reason('mp3', layer2)).toBe('unsupported')
})
