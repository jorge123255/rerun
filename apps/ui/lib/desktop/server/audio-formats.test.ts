import { expect, test } from 'vitest'
import { DesktopAudioBytesError, inspectDesktopAudioBytes, type DesktopAudioKind } from './audio-bytes'

const be32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
const box = (type: string, data: Buffer) => Buffer.concat([be32(data.length + 8), Buffer.from(type), data])
function m4a(handler = 'soun', codec = 'mp4a') {
    const hdlr = Buffer.alloc(24); hdlr.write(handler, 8)
    const entry = Buffer.alloc(28); entry.writeUInt16BE(1, 6); entry.writeUInt16BE(2, 16); entry.writeUInt16BE(16, 18); entry.writeUInt32BE(48000 * 65536, 24)
    const stsd = box('stsd', Buffer.concat([be32(0), be32(1), box(codec, entry)]))
    return Buffer.concat([box('ftyp', Buffer.concat([Buffer.from('M4A '), be32(0), Buffer.from('isom')])),
        box('moov', box('trak', box('mdia', Buffer.concat([box('hdlr', hdlr), box('minf', box('stbl', stsd))])))), box('mdat', Buffer.from([1]))])
}
function result(kind: DesktopAudioKind, bytes: Uint8Array) {
    try { inspectDesktopAudioBytes(kind, bytes); return 'ok' }
    catch (error) { return error instanceof DesktopAudioBytesError ? error.reason : 'unexpected' }
}
function oggPage(packet: Buffer, sequence: number, flags: number) {
    const bytes = Buffer.alloc(28 + packet.length)
    bytes.write('OggS'); bytes[5] = flags; bytes.writeUInt32LE(1, 14); bytes.writeUInt32LE(sequence, 18)
    bytes[26] = 1; bytes[27] = packet.length; bytes.set(packet, 28)
    let crc = 0
    for (const byte of bytes) {
        crc ^= byte << 24
        for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0
    }
    bytes.writeUInt32LE(crc, 22)
    return bytes
}
function ogg(sequence = 1) {
    const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = 1
    return Buffer.concat([oggPage(head, 0, 2), oggPage(Buffer.from('OpusTags'), sequence, 0), oggPage(Buffer.from([0xf8, 0xff, 0xfe]), 2, 4)])
}

test('M4A requires an audio track and nonempty media, with bounded structure', () => {
    expect(inspectDesktopAudioBytes('m4a', m4a())).toEqual({ contentType: 'audio/mp4' })
    expect(result('m4a', m4a('vide'))).toBe('unsupported')
    expect(result('m4a', m4a('soun', 'alac'))).toBe('unsupported')
    expect(result('m4a', m4a().subarray(0, -9))).toBe('corrupt')
    let nested = box('stsd', Buffer.alloc(8))
    for (let i = 0; i < 100; i++) nested = box('trak', nested)
    expect(result('m4a', Buffer.concat([box('ftyp', Buffer.concat([Buffer.from('M4A '), be32(0)])), box('moov', nested), box('mdat', Buffer.from([1]))]))).toBe('corrupt')
})

test('Ogg validation preserves Buffer input and checks checksums, sequence and completion', () => {
    const bytes = ogg(), saved = Buffer.from(bytes)
    expect(inspectDesktopAudioBytes('ogg', bytes)).toEqual({ contentType: 'audio/ogg' })
    expect(bytes).toEqual(saved)
    expect(result('ogg', ogg(4))).toBe('corrupt')
    expect(result('ogg', bytes.subarray(0, -1))).toBe('corrupt')
    const broken = Buffer.from(bytes); broken[broken.length - 1]! ^= 1
    expect(result('ogg', broken)).toBe('corrupt')
})

test('FLAC accepts its valid 32768-sample block-size code and refuses header-only data', () => {
    const info = Buffer.alloc(34)
    info.writeUInt16BE(32768); info.writeUInt16BE(32768, 2)
    info[10] = 0x0b; info[11] = 0xb8; info[12] = 0; info[13] = 0xf0 // 48000 Hz, mono, 16-bit
    const header = Buffer.from([0xff, 0xf8, 0xf0, 0x08, 0])
    let crc = 0
    for (const byte of header) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80 ? 7 : 0)) & 255 }
    const bytes = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info, header, Buffer.from([crc, 0, 0, 0])])
    expect(inspectDesktopAudioBytes('flac', bytes)).toEqual({ contentType: 'audio/flac' })
    expect(result('flac', bytes.subarray(0, -3))).toBe('corrupt')
})
