import { describe, expect, it } from 'vitest'
import { BINARY_MAX, JSON_MAX, decodeFrame, encodeFrame } from './frame.js'
import { IsolatedScreenRefusal } from './refusal.js'

describe('screen frames', () => {
    it('round-trips json and a png without adding or dropping bytes', () => {
        const binary = Buffer.from([1, 2, 3, 4])
        const frame = encodeFrame({ op: 'screenshot', ok: true }, binary)
        const decoded = decodeFrame(frame)
        expect(decoded.value).toEqual({ op: 'screenshot', ok: true })
        expect(decoded.binary.equals(binary)).toBe(true)
        expect(frame.readUInt32BE(0) + frame.readUInt32BE(4) + 8).toBe(frame.length)
    })

    it('rejects a short, padded, oversized, or invalid frame', () => {
        expect(() => decodeFrame(Buffer.from([1, 2, 3]))).toThrow(IsolatedScreenRefusal)
        const frame = encodeFrame({ ok: true })
        expect(() => decodeFrame(Buffer.concat([frame, Buffer.from([0])]))).toThrow(/too large/)
        const header = Buffer.alloc(8)
        header.writeUInt32BE(JSON_MAX + 1, 0)
        expect(() => decodeFrame(Buffer.concat([header, Buffer.alloc(4)]))).toThrow(/too large/)
        header.writeUInt32BE(2, 0)
        header.writeUInt32BE(BINARY_MAX + 1, 4)
        expect(() => decodeFrame(header)).toThrow(/too large/)
        const bad = Buffer.alloc(10)
        bad.writeUInt32BE(2, 0)
        bad.writeUInt32BE(0, 4)
        bad.write('[[', 8)
        expect(() => decodeFrame(bad)).toThrow(/not valid/)
        expect(() => encodeFrame({ text: 'x'.repeat(JSON_MAX) })).toThrow(/too large/)
        expect(() => encodeFrame({ ok: true }, Buffer.alloc(BINARY_MAX + 1))).toThrow(/too large/)
    })
})
