/** Structural checks for a desktop Files MP4 preview.
 * A passing file is an ISO BMFF container with an MP4 brand, a movie box, a video handler,
 * and media data. Sample payloads are not decoded, so this does not prove the browser can play it. */

export const DESKTOP_VIDEO_MAX_BYTES = 16 * 1024 * 1024

export type DesktopVideoKind = 'mp4'
export type DesktopVideoContentType = 'video/mp4'

const CONTENT_TYPE: Record<DesktopVideoKind, DesktopVideoContentType> = { mp4: 'video/mp4' }

/** Major or compatible brands from ordinary MP4 files. QuickTime-only, 3GPP, and M4A are absent. */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'hvc1', 'hev1', 'dash', 'MSNV', 'M4V '])
const CONTAINERS = new Set(['trak', 'edts', 'mdia', 'minf', 'dinf', 'stbl', 'mvex', 'moof', 'traf', 'udta', 'strk'])
const MAX_BOXES = 4096
const MAX_DEPTH = 16

export class DesktopVideoBytesError extends Error {
    readonly reason: 'mismatch' | 'corrupt' | 'unsupported'
    constructor(reason: 'mismatch' | 'corrupt' | 'unsupported') {
        super(reason)
        this.name = 'DesktopVideoBytesError'
        this.reason = reason
    }
}

export function desktopVideoKind(name: string): DesktopVideoKind | null {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    return ext === 'mp4' ? 'mp4' : null
}

type Scan = { boxes: number; ftyp: boolean; brand: boolean; moov: boolean; mdat: boolean; vide: boolean }

export function inspectDesktopVideoBytes(kind: DesktopVideoKind, bytes: Uint8Array): { contentType: DesktopVideoContentType } {
    if (kind !== 'mp4' || bytes.byteLength < 1 || bytes.byteLength > DESKTOP_VIDEO_MAX_BYTES) throw new DesktopVideoBytesError('corrupt')
    const state: Scan = { boxes: 0, ftyp: false, brand: false, moov: false, mdat: false, vide: false }
    try { readBoxes(bytes, 0, bytes.length, 0, false, state) }
    catch (error) {
        if (error instanceof DesktopVideoBytesError && error.reason === 'mismatch') throw error
        if (!state.ftyp) mismatch()
        throw error
    }
    if (!state.ftyp) mismatch()
    if (!state.brand) unsupported()
    if (!state.moov || !state.mdat) corrupt()
    if (!state.vide) unsupported()
    return { contentType: CONTENT_TYPE[kind] }
}

function readBoxes(bytes: Uint8Array, start: number, end: number, depth: number, inMoov: boolean, state: Scan): void {
    if (depth > MAX_DEPTH) corrupt()
    let offset = start
    while (offset < end) {
        if (state.boxes >= MAX_BOXES) corrupt()
        state.boxes += 1
        if (end - offset < 8) corrupt()
        const size32 = u32be(bytes, offset)
        const type = ascii(bytes, offset + 4, 4)
        let header = 8
        let size = size32
        if (size32 === 1) {
            if (end - offset < 16) corrupt()
            size = u64be(bytes, offset + 8)
            header = 16
            if (size < 16) corrupt()
        } else if (size32 === 0) size = end - offset
        else if (size32 < 8) corrupt()
        if (!Number.isSafeInteger(size) || size > end - offset) corrupt()
        const dataAt = offset + header
        const dataEnd = offset + size
        if (dataAt > dataEnd) corrupt()
        if (type === 'ftyp') {
            if (depth !== 0) corrupt()
            readFtyp(bytes, dataAt, dataEnd, state)
        } else if (type === 'mdat') {
            if (depth !== 0 || dataEnd - dataAt < 1) corrupt()
            state.mdat = true
        } else if (type === 'moov') {
            if (depth !== 0) corrupt()
            state.moov = true
            readBoxes(bytes, dataAt, dataEnd, depth + 1, true, state)
        } else if (type === 'hdlr') {
            if (inMoov) readHdlr(bytes, dataAt, dataEnd, state)
        } else if (CONTAINERS.has(type)) readBoxes(bytes, dataAt, dataEnd, depth + 1, inMoov, state)
        offset = dataEnd
    }
    if (offset !== end) corrupt()
}

function readFtyp(bytes: Uint8Array, start: number, end: number, state: Scan): void {
    const length = end - start
    if (length < 8 || (length - 8) % 4 !== 0) corrupt()
    state.ftyp = true
    for (let index = 0; index + 4 <= length; index += 4) {
        if (index === 4) continue
        if (MP4_BRANDS.has(ascii(bytes, start + index, 4))) state.brand = true
    }
}

function readHdlr(bytes: Uint8Array, start: number, end: number, state: Scan): void {
    if (end - start < 24 || bytes[start] !== 0) corrupt()
    if (ascii(bytes, start + 8, 4) === 'vide') state.vide = true
}

function u32be(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function u64be(bytes: Uint8Array, offset: number): number {
    const high = u32be(bytes, offset)
    const low = u32be(bytes, offset + 4)
    if (high > 0x1fffff) corrupt()
    const value = high * 0x100000000 + low
    if (!Number.isSafeInteger(value)) corrupt()
    return value
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    let text = ''
    for (let index = 0; index < length; index++) text += String.fromCharCode(bytes[offset + index]!)
    return text
}

function corrupt(): never {
    throw new DesktopVideoBytesError('corrupt')
}

function mismatch(): never {
    throw new DesktopVideoBytesError('mismatch')
}

function unsupported(): never {
    throw new DesktopVideoBytesError('unsupported')
}
