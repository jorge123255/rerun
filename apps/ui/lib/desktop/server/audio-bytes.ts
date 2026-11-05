/** Structural checks for a desktop Files audio preview. WAV, MP3, M4A, Ogg, and FLAC.
 * The bytes are not a hosted URL, HTML, or a video container. Sample decode stays in the browser. */

export const DESKTOP_AUDIO_MAX_BYTES = 16 * 1024 * 1024

export type DesktopAudioKind = 'wav' | 'mp3' | 'm4a' | 'ogg' | 'flac'
export type DesktopAudioContentType = 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/ogg' | 'audio/flac'

const CONTENT_TYPE: Record<DesktopAudioKind, DesktopAudioContentType> = {
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
}

export class DesktopAudioBytesError extends Error {
    readonly reason: 'mismatch' | 'corrupt' | 'unsupported'
    constructor(reason: 'mismatch' | 'corrupt' | 'unsupported') {
        super(reason)
        this.name = 'DesktopAudioBytesError'
        this.reason = reason
    }
}

export function desktopAudioKind(name: string): DesktopAudioKind | null {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    if (ext === 'wav') return 'wav'
    if (ext === 'mp3') return 'mp3'
    if (ext === 'm4a') return 'm4a'
    if (ext === 'ogg') return 'ogg'
    if (ext === 'flac') return 'flac'
    return null
}

export function inspectDesktopAudioBytes(kind: DesktopAudioKind, bytes: Uint8Array): { contentType: DesktopAudioContentType } {
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_AUDIO_MAX_BYTES) throw new DesktopAudioBytesError('corrupt')
    if (kind === 'wav') readWav(bytes)
    else if (kind === 'mp3') readMp3(bytes)
    else if (kind === 'm4a') readM4a(bytes)
    else if (kind === 'ogg') readOgg(bytes)
    else readFlac(bytes)
    return { contentType: CONTENT_TYPE[kind] }
}

function u16le(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u32le(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i]!)
    return text
}

function corrupt(): never {
    throw new DesktopAudioBytesError('corrupt')
}

function mismatch(): never {
    throw new DesktopAudioBytesError('mismatch')
}

function unsupported(): never {
    throw new DesktopAudioBytesError('unsupported')
}

const WAVE_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]

function readWav(bytes: Uint8Array): void {
    if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') mismatch()
    if (u32le(bytes, 4) !== bytes.length - 8) corrupt()
    let offset = 12
    let align = 0
    let sawFormat = false
    let sawData = false
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) corrupt()
        const id = ascii(bytes, offset, 4)
        // Unknown RIFF chunks are skipped by their bounded size. Metadata identifiers such
        // as Adobe's _PMX are valid FourCCs and need not be alphanumeric.
        const size = u32le(bytes, offset + 4)
        const dataAt = offset + 8
        const padded = size + (size & 1)
        if (size > bytes.length - dataAt || dataAt + padded > bytes.length) corrupt()
        if (id === 'fmt ') {
            if (sawFormat || sawData) corrupt()
            align = readWaveFormat(bytes.subarray(dataAt, dataAt + size))
            sawFormat = true
        } else if (id === 'data') {
            if (!sawFormat || size < 1 || align < 1 || size % align !== 0) corrupt()
            sawData = true
        }
        offset = dataAt + padded
    }
    if (!sawFormat || !sawData || offset !== bytes.length) corrupt()
}

function readWaveFormat(payload: Uint8Array): number {
    if (payload.length < 16) corrupt()
    let format = u16le(payload, 0)
    const channels = u16le(payload, 2)
    const rate = u32le(payload, 4)
    const byteRate = u32le(payload, 8)
    const align = u16le(payload, 12)
    const bits = u16le(payload, 14)
    if (format === 0xfffe) {
        if (payload.length < 40) corrupt()
        const extra = u16le(payload, 16)
        if (extra < 22) corrupt()
        const guidAt = 24
        if (guidAt + 16 > payload.length) corrupt()
        if (!WAVE_GUID_TAIL.every((byte, index) => payload[guidAt + 2 + index] === byte)) unsupported()
        format = u16le(payload, guidAt)
        const validBits = u16le(payload, 18)
        if (validBits < 1 || validBits > bits) corrupt()
    }
    if (format !== 1 && format !== 3) unsupported()
    const allowed = format === 1 ? [8, 16, 24, 32] : [32, 64]
    if (!allowed.includes(bits) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000) unsupported()
    const width = bits >> 3
    if (width < 1 || align !== channels * width || byteRate !== rate * align) corrupt()
    return align
}

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1]
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1]
const SAMPLE_RATES: Record<number, readonly number[]> = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000],
}

function readMp3(bytes: Uint8Array): void {
    if (bytes.length < 4) mismatch()
    let offset = 0
    let tagged = false
    if (ascii(bytes, 0, 3) === 'ID3') {
        offset = skipId3v2(bytes)
        tagged = true
    }
    if (!frameSync(bytes, offset)) {
        if (tagged) corrupt()
        mismatch()
    }
    let frames = 0
    while (offset < bytes.length) {
        if (bytes.length - offset === 128 && ascii(bytes, offset, 3) === 'TAG') {
            offset = bytes.length
            break
        }
        if (bytes[offset] === 0) {
            while (offset < bytes.length && bytes[offset] === 0) offset++
            if (offset !== bytes.length) corrupt()
            break
        }
        if (!frameSync(bytes, offset)) corrupt()
        const size = mp3FrameSize(bytes, offset)
        if (size < 24 || offset + size > bytes.length) corrupt()
        offset += size
        frames++
    }
    if (frames < 1 || offset !== bytes.length) corrupt()
}

function frameSync(bytes: Uint8Array, offset: number): boolean {
    return offset + 4 <= bytes.length && bytes[offset] === 0xff && (bytes[offset + 1]! & 0xe0) === 0xe0
}

function skipId3v2(bytes: Uint8Array): number {
    if (bytes.length < 10) corrupt()
    const major = bytes[3]!
    if (major < 2 || major > 4 || bytes[4] === 0xff) corrupt()
    const flags = bytes[5]!
    // Only v2.4 permits a footer, outside the declared body size. Its mirrored header
    // prevents silently accepting arbitrary bytes as a declared footer.
    const reserved = major === 2 ? 0x3f : major === 3 ? 0x1f : 0x0f
    if (flags & reserved) corrupt()
    const size = syncsafe(bytes, 6)
    let offset = 10 + size
    if (major === 4 && flags & 0x10) {
        if (offset + 10 > bytes.length || ascii(bytes, offset, 3) !== '3DI') corrupt()
        for (let index = 3; index < 10; index++) if (bytes[offset + index] !== bytes[index]) corrupt()
        offset += 10
    }
    if (offset > bytes.length) corrupt()
    return offset
}

function syncsafe(bytes: Uint8Array, offset: number): number {
    const parts = [bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!]
    if (parts.some(part => part & 0x80)) corrupt()
    return ((parts[0]! << 21) | (parts[1]! << 14) | (parts[2]! << 7) | parts[3]!) >>> 0
}

function mp3FrameSize(bytes: Uint8Array, offset: number): number {
    const version = (bytes[offset + 1]! >> 3) & 3
    const layer = (bytes[offset + 1]! >> 1) & 3
    const protection = bytes[offset + 1]! & 1
    if (version === 1 || layer === 0) corrupt()
    if (layer !== 1) unsupported()
    const bitrateIndex = bytes[offset + 2]! >> 4
    const sampleIndex = (bytes[offset + 2]! >> 2) & 3
    const padding = (bytes[offset + 2]! >> 1) & 1
    const rates = SAMPLE_RATES[version]
    if (!rates || sampleIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) corrupt()
    const kbps = (version === 3 ? MPEG1_L3 : MPEG2_L3)[bitrateIndex]!
    if (kbps < 0) corrupt()
    const unit = version === 3 ? 144 : 72
    const size = Math.floor(unit * kbps * 1000 / rates[sampleIndex]!) + padding
    if (protection === 0 && size < 6) corrupt()
    return size
}

function u16be(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u32be(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function u64be(bytes: Uint8Array, offset: number): bigint {
    return (BigInt(u32be(bytes, offset)) << BigInt(32)) | BigInt(u32be(bytes, offset + 4))
}

type Mp4Box = { type: string; start: number; end: number }
type Mp4Budget = { boxes: number }

function mp4Boxes(bytes: Uint8Array, start: number, end: number, budget: Mp4Budget): Mp4Box[] {
    const boxes: Mp4Box[] = []
    let offset = start
    while (offset < end) {
        if (++budget.boxes > 4096 || offset + 8 > end) corrupt()
        let size = u32be(bytes, offset)
        const type = ascii(bytes, offset + 4, 4)
        let header = 8
        if (size === 1) {
            if (offset + 16 > end) corrupt()
            const large = u64be(bytes, offset + 8)
            if (large > BigInt(end - offset)) corrupt()
            size = Number(large)
            header = 16
        } else if (size === 0) size = end - offset
        if (size < header || size > end - offset) corrupt()
        boxes.push({ type, start: offset + header, end: offset + size })
        offset += size
    }
    return boxes
}

const MP4_AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'mp42', 'mp41', 'isom', 'iso2', 'iso4', 'iso5', 'iso6'])

function readM4a(bytes: Uint8Array): void {
    // Walk only the finite movie/track/media/sample-table hierarchy. Arbitrary nested
    // container names must not recurse or let an unrelated stsd masquerade as audio.
    const budget = { boxes: 0 }
    const children = (box: Mp4Box) => mp4Boxes(bytes, box.start, box.end, budget)
    const top = mp4Boxes(bytes, 0, bytes.length, budget)
    const ftyp = top.find(box => box.type === 'ftyp')
    if (!ftyp || top.filter(box => box.type === 'ftyp').length !== 1) mismatch()
    const length = ftyp.end - ftyp.start
    if (length < 8 || (length - 8) % 4) corrupt()
    let brand = false
    for (let i = 0; i < length; i += 4) if (i !== 4 && MP4_AUDIO_BRANDS.has(ascii(bytes, ftyp.start + i, 4))) brand = true
    if (!brand) mismatch()
    const movies = top.filter(box => box.type === 'moov')
    if (movies.length !== 1 || !top.some(box => box.type === 'mdat' && box.end > box.start)) corrupt()
    let audio = false
    for (const track of children(movies[0]!).filter(box => box.type === 'trak')) {
        const media = children(track).filter(box => box.type === 'mdia')
        if (media.length !== 1) corrupt()
        const fields = children(media[0]!)
        const handlers = fields.filter(box => box.type === 'hdlr')
        if (handlers.length !== 1 || handlers[0]!.end - handlers[0]!.start < 24) corrupt()
        const handler = handlers[0]!
        if (bytes[handler.start] !== 0) corrupt()
        const type = ascii(bytes, handler.start + 8, 4)
        if (type === 'vide') unsupported()
        if (type !== 'soun') continue
        const minf = fields.filter(box => box.type === 'minf')
        if (minf.length !== 1) corrupt()
        const stbl = children(minf[0]!).filter(box => box.type === 'stbl')
        if (stbl.length !== 1) corrupt()
        const stsd = children(stbl[0]!).filter(box => box.type === 'stsd')
        if (stsd.length !== 1) corrupt()
        const samples = stsd[0]!
        if (samples.end - samples.start < 8 || u32be(bytes, samples.start) !== 0) corrupt()
        const count = u32be(bytes, samples.start + 4)
        const entries = mp4Boxes(bytes, samples.start + 8, samples.end, budget)
        if (count < 1 || count > 64 || count !== entries.length) corrupt()
        for (const entry of entries) {
            if (entry.type !== 'mp4a') unsupported()
            if (entry.end - entry.start < 28 || u16be(bytes, entry.start + 6) < 1) corrupt()
            // Version-zero ISO audio sample entry. Other versions/codecs stay explicit errors.
            if (u16be(bytes, entry.start + 8) !== 0) unsupported()
            const channels = u16be(bytes, entry.start + 16)
            const sampleRate = u32be(bytes, entry.start + 24) / 65536
            if (channels < 1 || channels > 8 || sampleRate < 1 || sampleRate > 768000) unsupported()
            audio = true
        }
    }
    if (!audio) unsupported()
}

const OGG_CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0
    OGG_CRC_TABLE[n] = c >>> 0
}

function oggCrc(bytes: Uint8Array): number {
    let c = 0
    for (let i = 0; i < bytes.length; i++) c = ((c << 8) >>> 0) ^ OGG_CRC_TABLE[((c >>> 24) ^ bytes[i]!) & 0xff]!
    return c >>> 0
}

function oggIdentIsAudio(ident: Uint8Array): boolean {
    if (ident.length >= 30 && ident[0] === 1 && ascii(ident, 1, 6) === 'vorbis') {
        return u32le(ident, 7) === 0 && ident[11]! >= 1 && ident[11]! <= 255
            && u32le(ident, 12) >= 1 && u32le(ident, 12) <= 768000 && ident[29] === 1
    }
    if (ident.length >= 19 && ascii(ident, 0, 8) === 'OpusHead') {
        return ident[8] === 1 && ident[9]! >= 1 && ident[9]! <= 255
    }
    if (ident.length >= 4 && ascii(ident, 0, 4) === 'fLaC') return true
    if (ident.length >= 9 && ident[0] === 0x7f && ascii(ident, 1, 4) === 'FLAC') return true
    return false
}

function readOgg(bytes: Uint8Array): void {
    type Stream = { sequence: number; continued: boolean; ended: boolean; packets: number; minimumPackets: number }
    const streams = new Map<number, Stream>()
    let offset = 0
    let pages = 0
    while (offset < bytes.length) {
        if (++pages > 65_536 || offset + 27 > bytes.length) corrupt()
        if (ascii(bytes, offset, 4) !== 'OggS') mismatch()
        if (bytes[offset + 4] !== 0) corrupt()
        const flags = bytes[offset + 5]!
        if (flags & 0xf8) corrupt()
        const segments = bytes[offset + 26]!
        const tableEnd = offset + 27 + segments
        if (tableEnd > bytes.length) corrupt()
        let payloadSize = 0
        let completed = 0
        for (let i = 0; i < segments; i++) {
            payloadSize += bytes[offset + 27 + i]!
            if (bytes[offset + 27 + i]! < 255) completed++
        }
        const end = tableEnd + payloadSize
        if (end > bytes.length) corrupt()
        // Buffer.slice is a view: never zero checksums in the bytes sent to the player.
        const page = Uint8Array.from(bytes.subarray(offset, end))
        page.fill(0, 22, 26)
        if (oggCrc(page) !== u32le(bytes, offset + 22)) corrupt()
        const serial = u32le(bytes, offset + 14)
        const sequence = u32le(bytes, offset + 18)
        let stream = streams.get(serial)
        if (!stream) {
            if (streams.size >= 16 || (flags & 3) !== 2 || sequence !== 0 || !completed) corrupt()
            let packetLength = 0
            for (let i = 0; i < segments; i++) {
                const lace = bytes[offset + 27 + i]!
                packetLength += lace
                if (lace < 255) break
            }
            const ident = bytes.subarray(tableEnd, tableEnd + packetLength)
            if (!oggIdentIsAudio(ident)) unsupported()
            const minimumPackets = ascii(ident, 0, 8) === 'OpusHead' ? 3 : ident[0] === 1 ? 4 : 2
            stream = { sequence, continued: false, ended: false, packets: 0, minimumPackets }
            streams.set(serial, stream)
        } else if (stream.ended || (flags & 2) || sequence !== (stream.sequence + 1) >>> 0 || !!(flags & 1) !== stream.continued) corrupt()
        stream.sequence = sequence
        stream.packets += completed
        if (segments) stream.continued = bytes[tableEnd - 1] === 255
        stream.ended = !!(flags & 4)
        if (stream.ended && stream.continued) corrupt()
        offset = end
    }
    if (!streams.size || [...streams.values()].some(stream => !stream.ended || stream.packets < stream.minimumPackets)) corrupt()
}

function readFlacStreamInfo(payload: Uint8Array): void {
    if (payload.length !== 34) corrupt()
    const minBlock = u16be(payload, 0)
    const maxBlock = u16be(payload, 2)
    const minFrame = (payload[4]! << 16) | (payload[5]! << 8) | payload[6]!
    const maxFrame = (payload[7]! << 16) | (payload[8]! << 8) | payload[9]!
    if (minBlock < 16 || maxBlock < minBlock || maxBlock > 65535 || maxFrame < minFrame) corrupt()
    const rate = (payload[10]! << 12) | (payload[11]! << 4) | (payload[12]! >> 4)
    const channels = ((payload[12]! >> 1) & 7) + 1
    const bps = (((payload[12]! & 1) << 4) | (payload[13]! >> 4)) + 1
    if (rate < 1 || rate > 655350 || channels > 8 || bps < 4 || bps > 32) unsupported()
}

const FLAC_CRC8_TABLE = new Uint8Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
    FLAC_CRC8_TABLE[n] = c
}

function flacCrc8(bytes: Uint8Array): number {
    let c = 0
    for (const byte of bytes) c = FLAC_CRC8_TABLE[(c ^ byte) & 0xff]!
    return c
}

function readFlacFrameHeader(bytes: Uint8Array, offset: number): void {
    if (offset + 4 > bytes.length) corrupt()
    if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xfc) !== 0xf8 || (bytes[offset + 1]! & 0x02) !== 0) corrupt()
    const blockCode = bytes[offset + 2]! >> 4
    const rateCode = bytes[offset + 2]! & 0x0f
    const channelCode = bytes[offset + 3]! >> 4
    const bpsCode = (bytes[offset + 3]! >> 1) & 7
    if (channelCode > 10 || (bytes[offset + 3]! & 1) !== 0 || bpsCode === 3 || rateCode === 15 || blockCode === 0) corrupt()
    let cursor = offset + 4
    let leading = 0
    for (let bit = 7; bit >= 0 && cursor < bytes.length; bit--) {
        if (bytes[cursor]! & (1 << bit)) leading++
        else break
    }
    const codedLength = leading === 0 ? 1 : leading
    if (leading === 1 || leading > 7 || cursor + codedLength > bytes.length) corrupt()
    for (let i = 1; i < codedLength; i++) if ((bytes[cursor + i]! & 0xc0) !== 0x80) corrupt()
    cursor += codedLength
    const need = (blockCode === 6 ? 1 : blockCode === 7 ? 2 : 0) + (rateCode === 12 ? 1 : rateCode === 13 || rateCode === 14 ? 2 : 0)
    if (cursor + need + 4 > bytes.length) corrupt()
    cursor += need
    if (flacCrc8(bytes.subarray(offset, cursor)) !== bytes[cursor]!) corrupt()
}

function readFlac(bytes: Uint8Array): void {
    if (bytes.length < 42) mismatch()
    if (ascii(bytes, 0, 4) !== 'fLaC') mismatch()
    let offset = 4
    let sawStreamInfo = false
    for (let block = 0; ; block++) {
        if (offset + 4 > bytes.length) corrupt()
        const header = bytes[offset]!
        const type = header & 0x7f
        const last = (header & 0x80) !== 0
        if (type === 127 || (block === 0 && type !== 0)) corrupt()
        const length = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
        const dataAt = offset + 4
        if (length > bytes.length - dataAt) corrupt()
        if (type === 0) {
            if (sawStreamInfo) corrupt()
            readFlacStreamInfo(bytes.subarray(dataAt, dataAt + length))
            sawStreamInfo = true
        }
        offset = dataAt + length
        if (last) break
    }
    if (!sawStreamInfo || offset >= bytes.length) corrupt()
    readFlacFrameHeader(bytes, offset)
}
