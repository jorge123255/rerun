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
