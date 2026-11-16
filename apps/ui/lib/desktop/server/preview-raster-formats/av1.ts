import { Bytes, checkOpen, dimensions, fail } from './common'

type Sequence = { width: number; height: number; reduced: boolean; frameIdBits: number; screenTools: number; integerMv: number; presentationBits: number }
const SELECT = 2
function bits(payload: Uint8Array) {
    let bit = 0
    return function read(count: number): number {
        if (bit + count > payload.length * 8) fail('corrupt')
        let value = 0
        for (let i = 0; i < count; i++, bit++) value = value * 2 + (payload[bit >>> 3]! >>> (7 - bit % 8) & 1)
        return value
    }
}

/** `general` admits the ordinary (non-reduced) header an image sequence's frames carry: one
 * operating point, no layers and no super-resolution. A still item never passes it. */
function sequenceHeader(payload: Uint8Array, general: boolean): Sequence {
    const read = bits(payload)
    if (read(3) > 2) fail('unsupported')
    const still = read(1), reduced = read(1) === 1
    let presentationBits = 0
    if (reduced) {
        if (!still) fail('unsupported')
        read(5)
    } else {
        if (!general) fail('unsupported')
        let decoderModel = false, delayBits = 0
        if (read(1)) {
            read(32); read(32)
            const equalInterval = read(1)
            if (equalInterval) {
                let zeros = 0
                while (!read(1)) if (++zeros > 32) fail('corrupt')
                if (zeros < 32) read(zeros)
            }
            decoderModel = read(1) === 1
            if (decoderModel) {
                delayBits = read(5) + 1; read(32); read(5)
                const frameBits = read(5) + 1
                if (!equalInterval) presentationBits = frameBits
            }
        }
        const displayDelay = read(1)
        if (read(5) !== 0 || read(12) !== 0) fail('unsupported')
        if (read(5) > 7) read(1)
        if (decoderModel && read(1)) { read(delayBits); read(delayBits); read(1) }
        if (displayDelay && read(1)) read(4)
    }
    const widthBits = read(4) + 1, heightBits = read(4) + 1
    const width = read(widthBits) + 1, height = read(heightBits) + 1
    dimensions(width, height)
    let frameIdBits = 0, screenTools = SELECT, integerMv = SELECT
    if (!reduced && read(1)) { const delta = read(4) + 2; frameIdBits = delta + read(3) + 1 }
    read(3)
    if (!reduced) {
        read(4)
        const orderHint = read(1)
        if (orderHint) read(2)
        screenTools = read(1) ? SELECT : read(1)
        if (screenTools > 0 && !read(1)) integerMv = read(1)
        if (orderHint) read(3)
    }
    if (read(1)) fail('unsupported')
    return { width, height, reduced, frameIdBits, screenTools, integerMv, presentationBits }
}

/** Under a general header the frame itself must say it is one shown key frame on the sequence
 * canvas: not a repeat of an earlier frame, not an inter frame, and not a resized one. */
function shownKeyFrame(payload: Uint8Array, sequence: Sequence): void {
    const read = bits(payload)
    if (read(1) !== 0 || read(2) !== 0 || read(1) !== 1) fail('unsupported')
    if (sequence.presentationBits) read(sequence.presentationBits)
    read(1)
    const screenTools = sequence.screenTools === SELECT ? read(1) : sequence.screenTools
    if (screenTools && sequence.integerMv === SELECT) read(1)
    if (sequence.frameIdBits) read(sequence.frameIdBits)
    if (read(1)) fail('unsupported')
}

// Reduced still-picture headers force one key frame on the sequence canvas. `general` is set only
// for the first frame of an image sequence, whose header and frame are then read bit by bit.
// Super-resolution, spatial layers and redundant frames stay refused.
export function inspectAv1Item(config: Uint8Array, data: Uint8Array, expected: { width: number; height: number }, signal: AbortSignal, general = false): void {
    let sequence: Sequence | undefined
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
                const size = sequenceHeader(payload, general)
                if (size.width !== expected.width || size.height !== expected.height) fail('corrupt')
                sequence = size
                sawSequence = true
            } else if (type === 2) {
                if (!image || length !== 0 || frameCount) fail('unsupported')
            } else if (type === 3 || type === 6) {
                if (!image || !sawSequence || !length) fail('corrupt')
                if (++frameCount !== 1) fail('animation')
                if (!sequence!.reduced) shownKeyFrame(payload, sequence!)
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
