import { Bytes, checkOpen, dimensions, fail } from './common'

function sequenceSize(payload: Uint8Array): { width: number; height: number } {
    let bit = 0
    function read(count: number): number {
        if (bit + count > payload.length * 8) fail('corrupt')
        let value = 0
        for (let i = 0; i < count; i++, bit++) value = value * 2 + (payload[bit >>> 3]! >>> (7 - bit % 8) & 1)
        return value
    }
    if (read(3) > 2) fail('unsupported')
    const still = read(1), reduced = read(1)
    if (!still || !reduced) fail('unsupported')
    read(5)
    const widthBits = read(4) + 1, heightBits = read(4) + 1
    const width = read(widthBits) + 1, height = read(heightBits) + 1
    dimensions(width, height)
    read(3)
    if (read(1)) fail('unsupported')
    return { width, height }
}

// Reduced still-picture headers force one key frame on the sequence canvas. General temporal
// headers, super-resolution, spatial layers and redundant frames need a separate parser.
export function inspectAv1Item(config: Uint8Array, data: Uint8Array, expected: { width: number; height: number }, signal: AbortSignal): void {
    let sawSequence = false, frameCount = 0, tiles = 0, fullFrame = false, count = 0
    function scan(bytes: Uint8Array, image: boolean) {
        const r = new Bytes(bytes)
        let at = 0
        while (at < bytes.length) {
            checkOpen(signal)
            if (++count > 1024) fail('unsupported')
            const header = r.u8(at++), type = header >>> 3 & 15
            if ((header & 0x81) !== 0 || !(header & 2)) fail('unsupported')
            if (header & 4) { if (r.u8(at++) !== 0) fail('unsupported') }
            let length = 0, finished = false
            for (let i = 0; i < 8; i++) {
                const part = r.u8(at++)
                length += (part & 127) * 2 ** (i * 7)
                if (!Number.isSafeInteger(length)) fail('corrupt')
                if (!(part & 128)) { finished = true; break }
            }
            if (!finished) fail('corrupt')
            r.range(at, length)
            const payload = bytes.subarray(at, at + length)
            at += length
            if (type === 1) {
                if (frameCount) fail('corrupt')
                const size = sequenceSize(payload)
                if (size.width !== expected.width || size.height !== expected.height) fail('corrupt')
                sawSequence = true
            } else if (type === 2) {
                if (!image || length !== 0 || frameCount) fail('unsupported')
            } else if (type === 3 || type === 6) {
                if (!image || !sawSequence || !length) fail('corrupt')
                if (++frameCount !== 1) fail('animation')
                fullFrame = type === 6
            } else if (type === 4) {
                if (!image || frameCount !== 1 || fullFrame || !length) fail('corrupt')
                tiles++
            } else if (type !== 5 && type !== 15) fail('unsupported')
        }
    }
    scan(config, false)
    scan(data, true)
    if (!sawSequence || frameCount !== 1 || (!fullFrame && !tiles)) fail('corrupt')
}
