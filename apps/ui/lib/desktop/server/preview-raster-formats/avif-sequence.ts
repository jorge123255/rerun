import { DESKTOP_PREVIEW_MAX_FRAMES } from '../animated-image'
import { Bytes, checkInput, checkOpen, fail } from './common'

type Box = { type: string; at: number; data: number; end: number }

/**
 * An animated AVIF (an AV1 image sequence) keeps its frames as samples of a `moov` track and,
 * as written by the common encoders, repeats the first frame as an ordinary still item in `meta`.
 * This reads only box headers: it counts the sequence's samples within the animation frame limit,
 * then returns a copy in which the `moov` box is renamed to `free` and the sequence brands are
 * replaced by the still brands. Offsets do not move, so the copy is a still AVIF whose one image
 * is the first frame. The copy still has to pass the still inspection and its decode limits; a
 * sequence without such a still item fails there. No sample is located, read or decoded here.
 */
export function avifSequenceStill(input: Uint8Array, signal: AbortSignal): { bytes: Uint8Array; frames: number } {
    checkInput(input, signal)
    const r = new Bytes(input)
    let count = 0
    function boxes(start: number, end: number): Box[] {
        const out: Box[] = []
        while (start < end) {
            checkOpen(signal)
            if (++count > 512) fail('unsupported')
            if (end - start < 8) fail('corrupt')
            let size = r.u32(start), header = 8
            if (size === 1) { size = r.uint(start + 8, 8); header = 16 }
            if (size < header || size > end - start) fail('corrupt')
            out.push({ type: r.ascii(start + 4, 4), at: start, data: start + header, end: start + size })
            start += size
        }
        return out
    }
    const only = (list: Box[], type: string): Box => {
        const found = list.filter(box => box.type === type)
        if (found.length !== 1) fail('corrupt')
        return found[0]!
    }
    const top = boxes(0, input.length)
    const ftyp = top[0]
    if (ftyp?.type !== 'ftyp' || top.filter(box => box.type === 'ftyp').length !== 1) fail('mismatch')
    const brandBytes = ftyp.end - ftyp.data
    if (brandBytes > 256) fail('unsupported')
    if (brandBytes < 8 || brandBytes % 4 !== 0) fail('corrupt')
    const brandAt = [ftyp.data]
    for (let at = ftyp.data + 8; at < ftyp.end; at += 4) brandAt.push(at)
    const sequenceBrands = brandAt.filter(at => r.ascii(at, 4) === 'avis')
    const movies = top.filter(box => box.type === 'moov')
    if (movies.length !== 1 || !sequenceBrands.length) fail('animation')
    const inside = (box: Box) => boxes(box.data, box.end)
    const tracks = inside(movies[0]!).filter(box => box.type === 'trak')
    if (!tracks.length || tracks.length > 8) fail('unsupported')
    let frames = 0
    for (const track of tracks) {
        const media = inside(only(inside(track), 'mdia'))
        const handler = only(media, 'hdlr')
        if (handler.end - handler.data < 12) fail('corrupt')
        const kind = r.ascii(handler.data + 8, 4)
        // The colour sequence, and the auxiliary (alpha) sequence that mirrors it frame for frame.
        if (kind !== 'pict' && kind !== 'auxv') fail('unsupported')
        const sizes = only(inside(only(inside(only(media, 'minf')), 'stbl')), 'stsz')
        if (sizes.end - sizes.data < 12 || r.u32(sizes.data) !== 0) fail('corrupt')
        const samples = r.u32(sizes.data + 8)
        if (samples < 1) fail('corrupt')
        if (samples > DESKTOP_PREVIEW_MAX_FRAMES) fail('frames')
        if (kind === 'pict') frames = Math.max(frames, samples)
    }
    if (!frames) fail('unsupported')
    const bytes = new Uint8Array(input)
    bytes.set([0x66, 0x72, 0x65, 0x65], movies[0]!.at + 4) // 'free'
    for (const at of sequenceBrands) bytes.set([0x61, 0x76, 0x69, 0x66], at) // 'avif'
    // The structural brand that makes a decoder insist on the movie box becomes its still twin.
    for (const at of brandAt) if (r.ascii(at, 4) === 'msf1') bytes.set([0x6d, 0x69, 0x66, 0x31], at) // 'mif1'
    return { bytes, frames }
}
