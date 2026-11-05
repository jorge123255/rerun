// Synthetic containers exercise inspection; only the root-run codec regression produces real AV1.
import { deflateSync } from 'node:zlib'

export function bmp24(width = 2, height = 2, topDown = false): Buffer {
    const stride = Math.ceil(width * 24 / 32) * 4, out = Buffer.alloc(54 + stride * height)
    out.write('BM'); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10); out.writeUInt32LE(40, 14)
    out.writeInt32LE(width, 18); out.writeInt32LE(topDown ? -height : height, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(stride * height, 34)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const row = topDown ? y : height - 1 - y, at = 54 + row * stride + x * 3
        out[at] = y ? 255 : 0; out[at + 1] = x ? 255 : 0; out[at + 2] = y ? 0 : 255
    }
    return out
}
export function bmpIndexed(): Buffer {
    const out = Buffer.alloc(66)
    out.write('BM'); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(62, 10); out.writeUInt32LE(40, 14)
    out.writeInt32LE(2, 18); out.writeInt32LE(1, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(1, 28)
    out.set([0, 0, 255, 0, 255, 0, 0, 0], 54); out[62] = 0x40
    return out
}
export function iconDib(width = 1, height = 1, alpha = 255, transparentMask = false): Buffer {
    const stride = width * 4, maskStride = Math.ceil(width / 32) * 4, out = Buffer.alloc(40 + (stride + maskStride) * height)
    out.writeUInt32LE(40); out.writeInt32LE(width, 4); out.writeInt32LE(height * 2, 8); out.writeUInt16LE(1, 12); out.writeUInt16LE(32, 14)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.set([0, 0, 255, alpha], 40 + y * stride + x * 4)
    if (transparentMask) out.fill(255, 40 + stride * height)
    return out
}
export function ico(frames: Array<{ bytes: Buffer; width: number; height: number; bits?: number }>): Buffer {
    const header = Buffer.alloc(6 + frames.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4)
    let offset = header.length
    frames.forEach((frame, index) => {
        const at = 6 + index * 16
        header[at] = frame.width === 256 ? 0 : frame.width; header[at + 1] = frame.height === 256 ? 0 : frame.height
        header.writeUInt16LE(1, at + 4); header.writeUInt16LE(frame.bits ?? 32, at + 6); header.writeUInt32LE(frame.bytes.length, at + 8); header.writeUInt32LE(offset, at + 12)
        offset += frame.bytes.length
    })
    return Buffer.concat([header, ...frames.map(frame => frame.bytes)])
}
function crc(bytes: Buffer): number {
    let value = 0xffffffff
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0) }
    return (value ^ 0xffffffff) >>> 0
}
export function pngChunk(type: string, payload: Buffer): Buffer {
    const header = Buffer.alloc(8), tail = Buffer.alloc(4)
    header.writeUInt32BE(payload.length); header.write(type, 4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), payload])))
    return Buffer.concat([header, payload, tail])
}
export function png1(): Buffer {
    const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))])
}
export function box(type: string, ...payload: Buffer[]): Buffer {
    const data = Buffer.concat(payload), header = Buffer.alloc(8); header.writeUInt32BE(data.length + 8); header.write(type, 4)
    return Buffer.concat([header, data])
}
const u16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes }
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes }
const full = (type: string, payload: Buffer, version = 0) => box(type, Buffer.from([version, 0, 0, 0]), payload)
export function avifContainer(options: { width?: number; height?: number; dataReference?: number; brand?: string; itemType?: string; codedWidth?: number; codedHeight?: number; extraFrame?: boolean } = {}): Buffer {
    const ftyp = box('ftyp', Buffer.from(options.brand ?? 'avif'), u32(0), Buffer.from('avifmif1'))
    const hdlr = full('hdlr', Buffer.concat([u32(0), Buffer.from('pict'), Buffer.alloc(12), Buffer.from([0])]))
    const pitm = full('pitm', u16(1))
    const iinf = full('iinf', Buffer.concat([u16(1), full('infe', Buffer.concat([u16(1), u16(0), Buffer.from(options.itemType ?? 'av01'), Buffer.from([0])]), 2)]))
    const ispe = full('ispe', Buffer.concat([u32(options.width ?? 1), u32(options.height ?? 1)]))
    const iprp = box('iprp', box('ipco', ispe, box('av1C', Buffer.from([0x81, 0, 0, 0]))), full('ipma', Buffer.concat([u32(1), u16(1), Buffer.from([2, 0x81, 0x82])])))
    const coded = Buffer.concat([syntheticAv1(options.codedWidth ?? options.width ?? 1, options.codedHeight ?? options.height ?? 1), options.extraFrame ? Buffer.from([0x32, 1, 0]) : Buffer.alloc(0)])
    const meta = (offset: number) => full('meta', Buffer.concat([hdlr, pitm, iinf, full('iloc', Buffer.concat([Buffer.from([0x44, 0]), u16(1), u16(1), u16(options.dataReference ?? 0), u16(1), u32(offset), u32(coded.length)])), iprp]))
    const offset = ftyp.length + meta(0).length + 8
    return Buffer.concat([ftyp, meta(offset), box('mdat', coded)])
}

export function bmpBitfields(alpha = false): Buffer {
    const masks = alpha ? [0xff0000, 0xff00, 0xff, 0xff000000] : [0xf800, 0x07e0, 0x001f]
    const out = Buffer.alloc(54 + masks.length * 4 + 4)
    bmp24(1, 1).copy(out, 0, 0, 54)
    out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54 + masks.length * 4, 10)
    out.writeUInt16LE(alpha ? 32 : 16, 28); out.writeUInt32LE(alpha ? 6 : 3, 30)
    masks.forEach((mask, index) => out.writeUInt32LE(mask, 54 + index * 4))
    if (alpha) out.writeUInt32LE(0x80ff0000, out.length - 4)
    else out.writeUInt16LE(0xf800, out.length - 4)
    return out
}

function syntheticAv1(width: number, height: number): Buffer {
    const bits: number[] = []
    const write = (value: number, count: number) => { for (let i = count - 1; i >= 0; i--) bits.push(value >>> i & 1) }
    const widthBits = Math.max(1, Math.ceil(Math.log2(width))), heightBits = Math.max(1, Math.ceil(Math.log2(height)))
    write(0, 3); write(1, 1); write(1, 1); write(0, 5)
    write(widthBits - 1, 4); write(heightBits - 1, 4); write(width - 1, widthBits); write(height - 1, heightBits); write(0, 4)
    const sequence = Buffer.alloc(Math.ceil(bits.length / 8))
    bits.forEach((value, index) => { sequence[index >>> 3] = sequence[index >>> 3]! | value << (7 - index % 8) })
    return Buffer.concat([Buffer.from([0x0a, sequence.length]), sequence, Buffer.from([0x32, 1, 0])])
}
