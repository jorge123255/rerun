import { expect, test } from 'vitest'
import { DesktopVideoBytesError, inspectDesktopVideoBytes } from './video-bytes'

function u32(value: number) {
    return Buffer.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}
function box(type: string, payload: Buffer) {
    return Buffer.concat([u32(8 + payload.length), Buffer.from(type), payload])
}
function ftyp(major: string, compatible: string[] = []) {
    return box('ftyp', Buffer.concat([Buffer.from(major), u32(0), ...compatible.map(brand => Buffer.from(brand))]))
}
function hdlr(handler: string) {
    const payload = Buffer.alloc(24)
    payload.set(Buffer.from(handler), 8)
    return box('hdlr', payload)
}
function movie(handler = 'vide') {
    return box('moov', box('trak', box('mdia', hdlr(handler))))
}
function mp4(handler = 'vide', major = 'isom', compatible = ['mp42']) {
    return Buffer.concat([ftyp(major, compatible), movie(handler), box('mdat', Buffer.from([0]))])
}

function reason(bytes: Uint8Array) {
    try { inspectDesktopVideoBytes('mp4', bytes) }
    catch (error) { return error instanceof DesktopVideoBytesError ? error.reason : 'other' }
    return 'ok'
}

test('accepts an MP4 container with a video handler', () => {
    expect(inspectDesktopVideoBytes('mp4', mp4())).toEqual({ contentType: 'video/mp4' })
})

test('refuses another container, a non-MP4 brand, audio-only media, and a broken box', () => {
    expect(reason(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBe('mismatch')
    expect(reason(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe('mismatch')
    expect(reason(mp4('vide', 'qt  ', ['qt  ']))).toBe('unsupported')
    expect(reason(mp4('vide', '3gp4', []))).toBe('unsupported')
    expect(reason(mp4('soun'))).toBe('unsupported')
    expect(reason(Buffer.concat([ftyp('isom', ['mp42']), movie()]))).toBe('corrupt')
    expect(reason(mp4().subarray(0, 30))).toBe('corrupt')
})

test('MOV and M4V use bounded movie/video/media validation without widening MP4 brands', () => {
    expect(inspectDesktopVideoBytes('mov', mp4('vide', 'qt  ', []))).toEqual({ contentType: 'video/quicktime' })
    expect(inspectDesktopVideoBytes('mov', Buffer.concat([movie(), box('mdat', Buffer.from([1]))]))).toEqual({ contentType: 'video/quicktime' })
    expect(inspectDesktopVideoBytes('m4v', mp4('vide', 'M4V ', []))).toEqual({ contentType: 'video/mp4' })
    expect(() => inspectDesktopVideoBytes('mov', mp4('soun', 'qt  ', []))).toThrowError(expect.objectContaining({ reason: 'unsupported' }))
    expect(() => inspectDesktopVideoBytes('m4v', mp4('vide', 'qt  ', []))).toThrowError(expect.objectContaining({ reason: 'unsupported' }))
})

function ebml(id: string, payload: Buffer, unknown = false) {
    const size = payload.length < 127 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x40 | (payload.length >> 8), payload.length & 255])
    return Buffer.concat([Buffer.from(id, 'hex'), unknown ? Buffer.from([255]) : size, payload])
}
function webm(options: { codec?: string; type?: number; unknown?: boolean; missingBlock?: boolean; trackNumber?: number; block?: Buffer; unknownBlock?: boolean } = {}) {
    const header = ebml('1a45dfa3', ebml('4282', Buffer.from('webm')))
    const track = ebml('ae', Buffer.concat([ebml('d7', Buffer.from([options.trackNumber ?? 1])), ebml('83', Buffer.from([options.type ?? 1])),
        ebml('86', Buffer.from(options.codec ?? 'V_VP8')), ebml('e0', Buffer.concat([ebml('b0', Buffer.from([2])), ebml('ba', Buffer.from([2]))]))]))
    const cluster = ebml('1f43b675', Buffer.concat([ebml('e7', Buffer.from([0])),
        ...(options.missingBlock ? [] : [ebml('a3', options.block ?? Buffer.from([0x81, 0, 0, 0x80, 1]), options.unknownBlock)])]), options.unknown)
    return Buffer.concat([header, ebml('18538067', Buffer.concat([ebml('1654ae6b', track), cluster]), options.unknown)])
}

test('WebM inspects video tracks and real block envelopes including streaming container sizes', () => {
    expect(inspectDesktopVideoBytes('webm', webm())).toEqual({ contentType: 'video/webm' })
    expect(inspectDesktopVideoBytes('webm', webm({ unknown: true }))).toEqual({ contentType: 'video/webm' })
    expect(() => inspectDesktopVideoBytes('webm', webm({ type: 2 }))).toThrowError(expect.objectContaining({ reason: 'unsupported' }))
    expect(() => inspectDesktopVideoBytes('webm', webm({ codec: 'V_MPEG4/ISO/AVC' }))).toThrowError(expect.objectContaining({ reason: 'unsupported' }))
    expect(() => inspectDesktopVideoBytes('webm', webm({ missingBlock: true }))).toThrowError(expect.objectContaining({ reason: 'corrupt' }))
    expect(() => inspectDesktopVideoBytes('webm', webm().subarray(0, -1))).toThrowError(expect.objectContaining({ reason: 'corrupt' }))
    expect(() => inspectDesktopVideoBytes('webm', mp4())).toThrowError(expect.objectContaining({ reason: 'mismatch' }))
})

test('WebM data VINTs allow all-one track numbers, first lace sizes, and positive lace deltas', () => {
    expect(inspectDesktopVideoBytes('webm', webm({ trackNumber: 127, block: Buffer.from([0xff, 0, 0, 0x80, 1]) }))).toEqual({ contentType: 'video/webm' })
    // Two laced frames: the first has 127 bytes (0xff), and the final one has one.
    const size127 = Buffer.concat([Buffer.from([0x81, 0, 0, 0x86, 1, 0xff]), Buffer.alloc(128, 1)])
    expect(inspectDesktopVideoBytes('webm', webm({ block: size127 }))).toEqual({ contentType: 'video/webm' })
    // Three laced frames of 1, 65, and 1 bytes. One-byte 0xff is a signed +64 delta.
    const delta64 = Buffer.concat([Buffer.from([0x81, 0, 0, 0x86, 2, 0x81, 0xff]), Buffer.alloc(67, 1)])
    expect(inspectDesktopVideoBytes('webm', webm({ block: delta64 }))).toEqual({ contentType: 'video/webm' })
})

test('WebM size markers and integer bounds remain restricted to safe block envelopes', () => {
    expect(() => inspectDesktopVideoBytes('webm', webm({ unknownBlock: true }))).toThrowError(expect.objectContaining({ reason: 'corrupt' }))
    expect(() => inspectDesktopVideoBytes('webm', webm({ block: Buffer.from([0x80, 0, 0, 0x80, 1]) }))).toThrowError(expect.objectContaining({ reason: 'corrupt' }))
    const unsafeTrack = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0x80, 1])
    expect(() => inspectDesktopVideoBytes('webm', webm({ block: unsafeTrack }))).toThrowError(expect.objectContaining({ reason: 'corrupt' }))
    const truncatedLace = Buffer.concat([Buffer.from([0x81, 0, 0, 0x86, 1, 0xff]), Buffer.alloc(127, 1)])
    expect(() => inspectDesktopVideoBytes('webm', webm({ block: truncatedLace }))).toThrowError(expect.objectContaining({ reason: 'corrupt' }))
})
