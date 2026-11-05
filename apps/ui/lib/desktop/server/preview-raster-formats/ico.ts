import { inspectDesktopImageBytes, DesktopImageBytesError } from '../image-bytes'
import { aggregate, Bytes, checkOpen, fail } from './common'
import { inspectBitmap, type BitmapPlan } from './bitmap'

export type IconFrame = { index: number; width: number; height: number; bits: number; bytes: Uint8Array; bitmap?: BitmapPlan }
export type IconPlan = { frames: IconFrame[]; selected: IconFrame; aggregatePixels: number }
export function inspectIcon(bytes: Uint8Array, signal: AbortSignal): IconPlan {
    const r = new Bytes(bytes)
    if (r.u16(0, true) !== 0 || r.u16(2, true) !== 1) fail('mismatch')
    const count = r.u16(4, true)
    if (count < 1) fail('corrupt')
    if (count > 64) fail('frames')
    const tableEnd = 6 + count * 16
    r.range(0, tableEnd)
    const ranges: Array<{ start: number; end: number }> = [], frames: IconFrame[] = []
    let aggregatePixels = 0
    for (let index = 0; index < count; index++) {
        checkOpen(signal)
        const at = 6 + index * 16, width = r.u8(at) || 256, height = r.u8(at + 1) || 256
        const colors = r.u8(at + 2), planes = r.u16(at + 4, true), declaredBits = r.u16(at + 6, true)
        if (r.u8(at + 3) !== 0 || (planes !== 0 && planes !== 1)) fail('corrupt')
        const length = r.u32(at + 8, true), start = r.u32(at + 12, true)
        if (!length || start < tableEnd) fail('corrupt')
        r.range(start, length)
        ranges.push({ start, end: start + length })
        const frame = bytes.subarray(start, start + length)
        let bits: number, bitmap: BitmapPlan | undefined
        if (frame[0] === 0x89 && frame[1] === 0x50 && frame[2] === 0x4e && frame[3] === 0x47) {
            try {
                const size = inspectDesktopImageBytes('png', frame)
                if (size.width !== width || size.height !== height) fail('corrupt')
            } catch (error) {
                if (error instanceof DesktopImageBytesError) fail(error.reason === 'dimensions' ? 'dimensions' : error.reason === 'animation' ? 'animation' : 'corrupt')
                throw error
            }
            const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
            bits = frame[24]! * channels[frame[25]!]!
            if (colors && (frame[25] !== 3 || colors > 2 ** frame[24]!)) fail('corrupt')
        } else {
            bitmap = inspectBitmap(frame, { width, height })
            bits = bitmap.bits
            if (colors && colors !== bitmap.colors) fail('corrupt')
        }
        if (declaredBits !== 0 && declaredBits !== bits) fail('corrupt')
        aggregatePixels += width * height
        aggregate(aggregatePixels)
        frames.push({ index, width, height, bits, bytes: frame, bitmap })
    }
    ranges.sort((a, b) => a.start - b.start)
    let end = tableEnd
    for (const range of ranges) { if (range.start !== end) fail('corrupt'); end = range.end }
    if (end !== bytes.length) fail('corrupt')
    const selected = [...frames].sort((a, b) => b.width * b.height - a.width * a.height || b.bits - a.bits || a.index - b.index)[0]!
    return { frames, selected, aggregatePixels }
}
