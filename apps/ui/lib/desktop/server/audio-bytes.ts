/** Structural checks for a desktop Files audio preview. WAV and MP3 only.
 * The bytes are not a hosted URL, HTML, or a video container. Sample decode stays in the browser. */

export const DESKTOP_AUDIO_MAX_BYTES = 16 * 1024 * 1024

export type DesktopAudioKind = 'wav' | 'mp3'
export type DesktopAudioContentType = 'audio/wav' | 'audio/mpeg'

const CONTENT_TYPE: Record<DesktopAudioKind, DesktopAudioContentType> = {
    wav: 'audio/wav', mp3: 'audio/mpeg',
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
    return null
}

export function inspectDesktopAudioBytes(kind: DesktopAudioKind, bytes: Uint8Array): { contentType: DesktopAudioContentType } {
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_AUDIO_MAX_BYTES) throw new DesktopAudioBytesError('corrupt')
    if (kind === 'wav') readWav(bytes)
    else readMp3(bytes)
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
