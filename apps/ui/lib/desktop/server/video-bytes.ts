/** Structural checks for a desktop Files MP4, M4V, MOV or WebM preview.
 * A passing file is an ISO BMFF container with an MP4 brand, a movie box, a video handler,
 * and media data. Sample payloads are not decoded, so this does not prove the browser can play it. */

export const DESKTOP_VIDEO_MAX_BYTES = 16 * 1024 * 1024

export type DesktopVideoKind = 'mp4' | 'm4v' | 'mov' | 'webm'
export type DesktopVideoContentType = 'video/mp4' | 'video/quicktime' | 'video/webm'

const CONTENT_TYPE: Record<DesktopVideoKind, DesktopVideoContentType> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }

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
    return ext === 'mp4' || ext === 'm4v' || ext === 'mov' || ext === 'webm' ? ext : null
}

type Scan = { kind: DesktopVideoKind; boxes: number; ftyp: boolean; brand: boolean; moov: boolean; mdat: boolean; vide: boolean }

export function inspectDesktopVideoBytes(kind: DesktopVideoKind, bytes: Uint8Array): { contentType: DesktopVideoContentType } {
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_VIDEO_MAX_BYTES) throw new DesktopVideoBytesError('corrupt')
    if (kind === 'webm') { readWebm(bytes); return { contentType: CONTENT_TYPE[kind] } }
    const state: Scan = { kind, boxes: 0, ftyp: false, brand: false, moov: false, mdat: false, vide: false }
    try { readBoxes(bytes, 0, bytes.length, 0, false, state) }
    catch (error) {
        if (error instanceof DesktopVideoBytesError && error.reason === 'mismatch') throw error
        if (!state.ftyp) mismatch()
        throw error
    }
    if (!state.ftyp && kind !== 'mov') mismatch()
    if (state.ftyp && !state.brand) unsupported()
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
        const brand = ascii(bytes, start + index, 4)
        if (MP4_BRANDS.has(brand) || (state.kind === 'mov' && brand === 'qt  ')) state.brand = true
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

type EbmlElement = { id: number; start: number; end: number; unknown: boolean }
type EbmlBudget = { elements: number }
const SEGMENT_FIELDS = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367])

/** EBML integers are bounded before converting to JS numbers. No recursive generic walk. */
function vint(bytes: Uint8Array, offset: number, end: number, kind: 'id' | 'size' | 'data' = 'size'): { length: number; value: number; unknown: boolean } {
    if (offset >= end || bytes[offset] === 0) corrupt()
    const id = kind === 'id'
    let length = 1
    while (length <= 8 && !(bytes[offset]! & (0x80 >> (length - 1)))) length++
    if (length > (id ? 4 : 8) || offset + length > end) corrupt()
    let value = BigInt(id ? bytes[offset]! : bytes[offset]! & ((1 << (8 - length)) - 1))
    for (let i = 1; i < length; i++) value = value * BigInt(256) + BigInt(bytes[offset + i]!)
    // Only element sizes reserve all-one VINTs for unknown length. Block track
    // numbers and EBML lace lengths/deltas use those same bits as integer data.
    const unknown = kind === 'size' && value === (BigInt(1) << BigInt(7 * length)) - BigInt(1)
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) corrupt()
    return { length, value: unknown ? 0 : Number(value), unknown }
}

function ebmlElement(bytes: Uint8Array, offset: number, end: number, budget: EbmlBudget): EbmlElement {
    if (++budget.elements > 65_536) corrupt()
    const id = vint(bytes, offset, end, 'id')
    const size = vint(bytes, offset + id.length, end)
    const start = offset + id.length + size.length
    if (size.unknown && id.value !== 0x18538067 && id.value !== 0x1f43b675) corrupt()
    if (!size.unknown && size.value > end - start) corrupt()
    return { id: id.value, start, end: size.unknown ? end : start + size.value, unknown: size.unknown }
}

function ebmlChildren(bytes: Uint8Array, parent: EbmlElement, budget: EbmlBudget): EbmlElement[] {
    const items: EbmlElement[] = []
    for (let offset = parent.start; offset < parent.end;) {
        const item = ebmlElement(bytes, offset, parent.end, budget)
        if (item.unknown) corrupt()
        items.push(item)
        offset = item.end
    }
    return items
}

function ebmlUint(bytes: Uint8Array, item: EbmlElement): number {
    if (item.end <= item.start || item.end - item.start > 8) corrupt()
    let value = BigInt(0)
    for (let i = item.start; i < item.end; i++) value = value * BigInt(256) + BigInt(bytes[i]!)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) corrupt()
    return Number(value)
}

function oneField(items: EbmlElement[], id: number): EbmlElement {
    const found = items.filter(item => item.id === id)
    if (found.length !== 1) corrupt()
    return found[0]!
}

function readWebm(bytes: Uint8Array): void {
    if (bytes.length < 4 || u32be(bytes, 0) !== 0x1a45dfa3) mismatch()
    const budget = { elements: 0 }
    const header = ebmlElement(bytes, 0, bytes.length, budget)
    const fields = ebmlChildren(bytes, header, budget)
    const doc = oneField(fields, 0x4282)
    if (ascii(bytes, doc.start, doc.end - doc.start) !== 'webm') unsupported()
    for (const field of fields) {
        const value = [0x42f7, 0x42f2, 0x42f3, 0x4285].includes(field.id) ? ebmlUint(bytes, field) : 0
        if ((field.id === 0x42f7 && value > 1) || (field.id === 0x42f2 && value > 4)
            || (field.id === 0x42f3 && value > 8) || (field.id === 0x4285 && value > 2)) unsupported()
    }
    let offset = header.end
    // Void and CRC elements may separate the EBML header from its one Segment.
    let segment: EbmlElement | undefined
    while (offset < bytes.length) {
        const item = ebmlElement(bytes, offset, bytes.length, budget)
        if (item.id === 0x18538067) { segment = item; break }
        if (item.id !== 0xec && item.id !== 0xbf) corrupt()
        offset = item.end
    }
    if (!segment || segment.end !== bytes.length) corrupt()
    const videoTracks = new Set<number>()
    const allTracks = new Set<number>()
    const usedTracks = new Set<number>()
    let tracksSeen = false
    let clusterSeen = false
    offset = segment.start
    while (offset < segment.end) {
        const item = ebmlElement(bytes, offset, segment.end, budget)
        if (item.id === 0x1654ae6b) {
            if (tracksSeen) corrupt()
            tracksSeen = true
            for (const entry of ebmlChildren(bytes, item, budget).filter(child => child.id === 0xae)) {
                if (allTracks.size >= 64) corrupt()
                const track = ebmlChildren(bytes, entry, budget)
                const number = ebmlUint(bytes, oneField(track, 0xd7))
                if (number < 1 || allTracks.has(number)) corrupt()
                allTracks.add(number)
                if (ebmlUint(bytes, oneField(track, 0x83)) !== 1) continue
                const codec = oneField(track, 0x86)
                if (!['V_VP8', 'V_VP9', 'V_AV1'].includes(ascii(bytes, codec.start, codec.end - codec.start))) unsupported()
                const video = ebmlChildren(bytes, oneField(track, 0xe0), budget)
                const width = ebmlUint(bytes, oneField(video, 0xb0))
                const height = ebmlUint(bytes, oneField(video, 0xba))
                if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216) unsupported()
                videoTracks.add(number)
            }
        } else if (item.id === 0x1f43b675) {
            clusterSeen = true
            offset = readWebmCluster(bytes, item, budget, usedTracks)
            continue
        } else if (item.unknown) corrupt()
        offset = item.end
    }
    if (!tracksSeen || !clusterSeen || !usedTracks.size) corrupt()
    if (!videoTracks.size || ![...usedTracks].some(track => videoTracks.has(track))) unsupported()
    if ([...usedTracks].some(track => !allTracks.has(track))) corrupt()
}

function readWebmCluster(bytes: Uint8Array, cluster: EbmlElement, budget: EbmlBudget, used: Set<number>): number {
    let offset = cluster.start
    while (offset < cluster.end) {
        const item = ebmlElement(bytes, offset, cluster.end, budget)
        if (cluster.unknown && SEGMENT_FIELDS.has(item.id)) return offset
        if (item.unknown || SEGMENT_FIELDS.has(item.id)) corrupt()
        if (item.id === 0xa3) readWebmBlock(bytes, item, used)
        else if (item.id === 0xa0) {
            const children = ebmlChildren(bytes, item, budget)
            readWebmBlock(bytes, oneField(children, 0xa1), used)
        }
        offset = item.end
    }
    return offset
}

function readWebmBlock(bytes: Uint8Array, block: EbmlElement, used: Set<number>): void {
    const track = vint(bytes, block.start, block.end, 'data')
    if (track.unknown || track.value < 1 || block.start + track.length + 4 > block.end) corrupt()
    const flagsAt = block.start + track.length + 2
    let offset = flagsAt + 1
    const lace = (bytes[flagsAt]! >> 1) & 3
    if (lace) {
        const frames = bytes[offset++]! + 1
        if (frames < 2 || offset >= block.end) corrupt()
        let total = 0
        if (lace === 2) {
            if ((block.end - offset) % frames || block.end - offset < frames) corrupt()
        } else {
            let previous = 0
            for (let frame = 0; frame < frames - 1; frame++) {
                let size = 0
                if (lace === 1) {
                    let chunk: number
                    do { if (offset >= block.end) corrupt(); chunk = bytes[offset++]!; size += chunk } while (chunk === 255)
                } else {
                    const value = vint(bytes, offset, block.end, 'data')
                    if (value.unknown) corrupt()
                    offset += value.length
                    size = frame === 0 ? value.value : previous + value.value - (2 ** (7 * value.length - 1) - 1)
                }
                if (!Number.isSafeInteger(size) || size < 1 || size > block.end - offset) corrupt()
                total += size
                previous = size
            }
            if (total >= block.end - offset) corrupt()
        }
    }
    used.add(track.value)
}
