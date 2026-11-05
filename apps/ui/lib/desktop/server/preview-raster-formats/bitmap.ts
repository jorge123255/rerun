import { setImmediate } from 'node:timers/promises'
import { Bytes, checkOpen, dimensions, fail } from './common'

export type BitmapPlan = {
    width: number; height: number; topDown: boolean; bits: number; stride: number; pixels: number
    palette: number; colors: number; masks: number[]; andMask?: number; maskStride?: number; icon: boolean
}
function maskValid(mask: number, bits: number): boolean {
    if (!mask || (bits < 32 && mask >= 2 ** bits)) return false
    while (mask % 2 === 0) mask /= 2
    return Number.isInteger(Math.log2(mask + 1))
}
export function inspectBitmap(bytes: Uint8Array, iconSize?: { width: number; height: number }): BitmapPlan {
    const r = new Bytes(bytes), icon = !!iconSize, base = icon ? 0 : 14
    if (!icon) {
        if (r.ascii(0, 2) !== 'BM') fail('mismatch')
        if (r.u32(2, true) !== bytes.length || r.u32(6, true) !== 0) fail('corrupt')
    }
    const header = r.u32(base, true)
    if (![40, 108, 124].includes(header)) fail('unsupported')
    r.range(base, header)
    const width = r.i32(base + 4), storedHeight = r.i32(base + 8)
    if (storedHeight === 0 || storedHeight === -2147483648 || (icon && storedHeight < 0)) fail('corrupt')
    const height = icon ? storedHeight / 2 : Math.abs(storedHeight)
    dimensions(width, height)
    if (iconSize && (width !== iconSize.width || height !== iconSize.height)) fail('corrupt')
    if (r.u16(base + 12, true) !== 1) fail('corrupt')
    const bits = r.u16(base + 14, true), compression = r.u32(base + 16, true)
    if (![1, 4, 8, 16, 24, 32].includes(bits)) fail('unsupported')
    if (![0, 3, 6].includes(compression) || (compression !== 0 && bits !== 16 && bits !== 32)) fail('unsupported')
    if (icon && compression !== 0) fail('unsupported')
    let end = base + header, masks: number[] = []
    if (compression !== 0) {
        const count = compression === 6 ? 4 : 3
        if (header === 40) { r.range(end, count * 4); masks = Array.from({ length: count }, (_, index) => r.u32(end + index * 4, true)); end += count * 4 }
        else masks = Array.from({ length: 4 }, (_, index) => r.u32(base + 40 + index * 4, true))
        if (masks.length === 4 && masks[3] === 0 && compression !== 6) masks.pop()
        if (masks.some(mask => !maskValid(mask, bits))) fail('corrupt')
        for (let i = 0; i < masks.length; i++) for (let j = 0; j < i; j++) if ((masks[i]! & masks[j]!) !== 0) fail('corrupt')
    } else if (bits === 16) masks = [0x7c00, 0x03e0, 0x001f]
    if (header >= 108) {
        const colorSpace = r.u32(base + 56, true)
        if (colorSpace === 0x4c494e4b || colorSpace === 0x4d424544) fail('unsupported')
        if (compression === 0 && [40, 44, 48, 52].some(offset => r.u32(base + offset, true) !== 0)) fail('unsupported')
    }
    if (header === 124 && (r.u32(base + 112, true) !== 0 || r.u32(base + 116, true) !== 0)) fail('unsupported')
    const used = r.u32(base + 32, true), colors = bits <= 8 ? used || 2 ** bits : 0
    if ((bits > 8 && used !== 0) || colors > 2 ** Math.min(bits, 8)) fail('corrupt')
    const palette = end
    r.range(palette, colors * 4)
    end += colors * 4
    const pixels = icon ? end : r.u32(10, true)
    if (pixels < end) fail('corrupt')
    const stride = Math.ceil(width * bits / 32) * 4, size = stride * height
    const declared = r.u32(base + 20, true)
    if (declared !== 0 && declared !== size) fail('corrupt')
    r.range(pixels, size)
    let andMask: number | undefined, maskStride: number | undefined
    if (icon) { andMask = pixels + size; maskStride = Math.ceil(width / 32) * 4; r.range(andMask, maskStride * height); end = andMask + maskStride * height }
    else end = pixels + size
    if (end !== bytes.length) fail('corrupt')
    return { width, height, topDown: storedHeight < 0, bits, stride, pixels, palette, colors, masks, andMask, maskStride, icon }
}
function channel(value: number, mask: number): number {
    let shift = 0
    while ((mask >>> shift & 1) === 0) shift++
    const maximum = mask >>> shift
    return Math.round(((value & mask) >>> shift) * 255 / maximum)
}
export async function decodeBitmap(bytes: Uint8Array, plan: BitmapPlan, signal: AbortSignal): Promise<Uint8Array> {
    checkOpen(signal)
    const r = new Bytes(bytes), out = new Uint8Array(plan.width * plan.height * 4)
    let anyAlpha = false
    for (let y = 0; y < plan.height; y++) {
        if (y % 16 === 0) { await setImmediate(); checkOpen(signal) }
        const row = plan.pixels + (plan.topDown ? y : plan.height - 1 - y) * plan.stride
        for (let x = 0; x < plan.width; x++) {
            const at = (y * plan.width + x) * 4
            if (plan.bits <= 8) {
                const bit = x * plan.bits, index = (r.u8(row + (bit >>> 3)) >>> (8 - plan.bits - bit % 8)) & (2 ** plan.bits - 1)
                if (index >= plan.colors) fail('corrupt')
                const color = plan.palette + index * 4
                out[at] = r.u8(color + 2); out[at + 1] = r.u8(color + 1); out[at + 2] = r.u8(color); out[at + 3] = 255
            } else if (plan.masks.length) {
                const value = plan.bits === 16 ? r.u16(row + x * 2, true) : r.u32(row + x * 4, true)
                for (let c = 0; c < 3; c++) out[at + c] = channel(value, plan.masks[c]!)
                out[at + 3] = plan.masks[3] ? channel(value, plan.masks[3]) : 255
            } else {
                const pixel = row + x * (plan.bits / 8)
                out[at] = r.u8(pixel + 2); out[at + 1] = r.u8(pixel + 1); out[at + 2] = r.u8(pixel)
                out[at + 3] = plan.icon && plan.bits === 32 ? r.u8(pixel + 3) : 255
                anyAlpha ||= out[at + 3] !== 0
            }
        }
    }
    if (plan.icon) {
        for (let y = 0; y < plan.height; y++) {
            if (y % 16 === 0) { await setImmediate(); checkOpen(signal) }
            const row = plan.andMask! + (plan.height - 1 - y) * plan.maskStride!
            for (let x = 0; x < plan.width; x++) {
                const alpha = (y * plan.width + x) * 4 + 3
                if (plan.bits === 32 && !anyAlpha) out[alpha] = 255
                if ((plan.bits !== 32 || !anyAlpha) && (r.u8(row + (x >>> 3)) & (0x80 >>> (x % 8)))) {
                    if (plan.bits === 1 && (r.u8(plan.pixels + (plan.height - 1 - y) * plan.stride + (x >>> 3)) & (0x80 >>> (x % 8)))) fail('unsupported')
                    out[alpha] = 0
                }
            }
        }
    }
    checkOpen(signal)
    return out
}
