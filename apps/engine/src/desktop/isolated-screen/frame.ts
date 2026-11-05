import { IsolatedScreenRefusal } from './refusal.js'

export const JSON_MAX = 1_000_000
export const BINARY_MAX = 8 * 1024 * 1024

export function encodeFrame(value: unknown, binary: Buffer = Buffer.alloc(0)): Buffer {
    const body = Buffer.from(JSON.stringify(value))
    if (body.length > JSON_MAX || binary.length > BINARY_MAX) throw new IsolatedScreenRefusal('The screen response is too large.', 'closed')
    const header = Buffer.alloc(8)
    header.writeUInt32BE(body.length, 0)
    header.writeUInt32BE(binary.length, 4)
    return Buffer.concat([header, body, binary])
}

export function decodeFrame(blob: Buffer): { value: unknown; binary: Buffer } {
    if (blob.length < 8) throw new IsolatedScreenRefusal('The screen request was cut off.', 'closed')
    const jsonLength = blob.readUInt32BE(0)
    const binaryLength = blob.readUInt32BE(4)
    if (jsonLength > JSON_MAX || binaryLength > BINARY_MAX || blob.length !== 8 + jsonLength + binaryLength) {
        throw new IsolatedScreenRefusal('The screen request is too large.', 'closed')
    }
    try {
        const value = JSON.parse(blob.subarray(8, 8 + jsonLength).toString('utf8')) as unknown
        return { value, binary: Buffer.from(blob.subarray(8 + jsonLength)) }
    } catch (error) {
        if (error instanceof IsolatedScreenRefusal) throw error
        throw new IsolatedScreenRefusal('The screen request was not valid.', 'refused')
    }
}
